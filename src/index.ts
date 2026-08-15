import PostalMime from "postal-mime";
import {
  DEFAULT_DANGEROUS_EXTENSIONS,
  DEFAULT_MACRO_EXTENSIONS,
  DEFAULT_OOXML_ZIP_EXTENSIONS,
} from "./attachment";
import { checkDnsbl } from "./dnsbl";
import { extractSenderIp } from "./received-header";
import { lookupRoute } from "./routing";
import { DEFAULT_SUSPICIOUS_TLDS, isSpam } from "./scoring";
import {
  combineScores,
  computeScores,
  DEFAULT_SIGNAL_WEIGHTS,
  dominantCategory,
  isValidScores,
  type Scores,
  type SignalCategory,
  type SignalContext,
} from "./signals";
import { type EventOutcome, StatsCounter } from "./stats-do";
import { renderStatsPage } from "./stats-page";

export { StatsCounter };

export interface Env {
  ROUTES: KVNamespace;
  DEFAULT_THRESHOLD: string;
  SIGNAL_WEIGHTS: string;
  REJECT_MESSAGE: string;
  /** Optional JSON object mapping a coarse signal category (reputation/attachment/links/content) to a reject message that overrides REJECT_MESSAGE for spam rejected mainly on that category's evidence. */
  REJECT_MESSAGES?: string;
  /** Optional: free Spamhaus DQS key. DNSBL check is skipped (scored neutral) when unset. */
  SPAMHAUS_DQS_KEY?: string;
  /** Optional JSON-array overrides for the built-in lists; falls back to defaults when unset/invalid. */
  SUSPICIOUS_TLDS?: string;
  DANGEROUS_EXTENSIONS?: string;
  MACRO_EXTENSIONS?: string;
  OOXML_ZIP_EXTENSIONS?: string;
  /** Lightweight usage-stats Durable Object. Only used when STATS_ENABLED is "true". */
  STATS?: DurableObjectNamespace<StatsCounter>;
  /** "true" to collect stats and serve them at GET /stats; anything else (including unset) disables the feature entirely. */
  STATS_ENABLED?: string;
  /** How many days of hourly / daily stats buckets to keep before pruning. */
  STATS_HOUR_RETENTION_DAYS?: string;
  STATS_DAY_RETENTION_DAYS?: string;
}

function isStatsEnabled(
  env: Env,
): env is Env & { STATS: DurableObjectNamespace<StatsCounter> } {
  return env.STATS_ENABLED === "true" && env.STATS !== undefined;
}

function statsRetention(env: Env) {
  return {
    hour: Number(env.STATS_HOUR_RETENTION_DAYS ?? "30"),
    day: Number(env.STATS_DAY_RETENTION_DAYS ?? "400"),
  };
}

/** Parses an optional JSON-array env var into a Set, falling back to `fallback` when unset or malformed. */
function parseSet(
  json: string | undefined,
  fallback: Set<string>,
): Set<string> {
  if (!json) return fallback;
  try {
    const values = JSON.parse(json);
    return Array.isArray(values) ? new Set(values) : fallback;
  } catch {
    return fallback;
  }
}

/** Parses SIGNAL_WEIGHTS, falling back to the built-in defaults (and logging) when malformed — deploy-time validation (`scripts/validate-config.mjs`) should catch this first, this is defense in depth so a bad config degrades gracefully instead of failing every email. */
function parseWeights(json: string): Scores {
  try {
    const parsed = JSON.parse(json);
    if (isValidScores(parsed)) return parsed;
  } catch {
    // fall through to the warning below
  }
  console.error(
    `Invalid SIGNAL_WEIGHTS config, falling back to defaults: ${json}`,
  );
  return DEFAULT_SIGNAL_WEIGHTS;
}

/** Parses REJECT_MESSAGES, falling back to an empty map (and logging) when malformed. */
function parseRejectMessages(
  json: string | undefined,
): Partial<Record<SignalCategory, string>> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((v) => typeof v === "string")
    ) {
      return parsed;
    }
  } catch {
    // fall through to the warning below
  }
  console.error(`Invalid REJECT_MESSAGES config, ignoring: ${json}`);
  return {};
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const [route, email] = await Promise.all([
      lookupRoute(env.ROUTES, message.to),
      new Response(message.raw)
        .arrayBuffer()
        .then((rawBuffer) => PostalMime.parse(rawBuffer)),
    ]);
    if (!route) {
      // No ROUTES entry means this address isn't meant to be handled by
      // this worker at all — misconfigured Email Routing rule, most likely.
      message.setReject("Recipient not configured");
      return;
    }

    const headerFrom = email.from?.address ?? message.from;
    const fromDomain = headerFrom.split("@")[1] ?? "";

    const topReceived = email.headers.find(
      (h) => h.key.toLowerCase() === "received",
    )?.value;
    const senderIp = extractSenderIp(topReceived);
    const dnsblPromise = checkDnsbl(senderIp, env.SPAMHAUS_DQS_KEY);

    const signalContext: SignalContext = {
      email,
      headerFrom,
      fromDomain,
      suspiciousTlds: parseSet(env.SUSPICIOUS_TLDS, DEFAULT_SUSPICIOUS_TLDS),
      dangerousExtensions: parseSet(
        env.DANGEROUS_EXTENSIONS,
        DEFAULT_DANGEROUS_EXTENSIONS,
      ),
      macroExtensions: parseSet(env.MACRO_EXTENSIONS, DEFAULT_MACRO_EXTENSIONS),
      ooxmlZipExtensions: parseSet(
        env.OOXML_ZIP_EXTENSIONS,
        DEFAULT_OOXML_ZIP_EXTENSIONS,
      ),
      dnsblResult: dnsblPromise,
    };
    const scores = await computeScores(signalContext);
    const dnsblResult = await dnsblPromise;
    const weights = parseWeights(env.SIGNAL_WEIGHTS);
    const score = combineScores(scores, weights);
    const threshold = route.threshold ?? Number(env.DEFAULT_THRESHOLD);
    const spam = isSpam(score, threshold);

    const recordStats = async (outcome: EventOutcome) => {
      if (!isStatsEnabled(env)) return;
      try {
        const stats = env.STATS.get(env.STATS.idFromName("stats"));
        await stats.recordEvent(
          scores,
          outcome,
          new Date().toISOString(),
          statsRetention(env),
        );
      } catch (error) {
        // Stats collection is best-effort — never let it block mail delivery.
        console.error(`Failed to record stats: ${error}`);
      }
    };

    if (spam) {
      console.log(
        JSON.stringify({
          to: message.to,
          from: headerFrom,
          subject: email.subject,
          senderIp,
          dnsblResult,
          scores,
          score,
          threshold,
          verdict: "reject",
        }),
      );
      await recordStats("spam");
      const category = dominantCategory(scores, weights);
      const rejectMessages = parseRejectMessages(env.REJECT_MESSAGES);
      message.setReject(rejectMessages[category] ?? env.REJECT_MESSAGE);
      return;
    }

    const forwardResults = await Promise.allSettled(
      route.destinations.map((destination) => message.forward(destination)),
    );
    const failures = forwardResults.flatMap((result, i) =>
      result.status === "rejected"
        ? [{ destination: route.destinations[i], error: result.reason }]
        : [],
    );
    if (failures.length > 0) {
      // Uncaught here means Cloudflare reports a *temporary* failure to the sender, who keeps retrying forever.
      for (const { destination, error } of failures) {
        console.error(
          `Forward to ${destination} failed, rejecting instead: ${error}`,
        );
      }
      await recordStats("failed");
      message.setReject(env.REJECT_MESSAGE);
      return;
    }

    console.log(
      JSON.stringify({
        to: message.to,
        from: headerFrom,
        subject: email.subject,
        senderIp,
        dnsblResult,
        scores,
        score,
        threshold,
        verdict: "forward",
      }),
    );
    await recordStats("forwarded");
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isJson = url.pathname === "/stats.json";
    const isHtml = url.pathname === "/stats" || url.pathname === "/stats.html";

    if (!isStatsEnabled(env) || !(isJson || isHtml)) {
      return new Response("Not found", { status: 404 });
    }

    const granularity =
      url.searchParams.get("granularity") === "day" ? "day" : "hour";
    const requestedLimit = Number(url.searchParams.get("limit"));
    const defaultLimit = granularity === "hour" ? 48 : 90;
    const limit =
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 500)
        : defaultLimit;

    const stats = env.STATS.get(env.STATS.idFromName("stats"));
    const buckets = await stats.getStats(granularity, limit);

    if (isHtml) {
      return new Response(renderStatsPage(granularity, buckets), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return Response.json({ granularity, buckets });
  },
};
