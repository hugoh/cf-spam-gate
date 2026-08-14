import PostalMime from "postal-mime";
import {
  attachmentScore,
  DEFAULT_DANGEROUS_EXTENSIONS,
  DEFAULT_MACRO_EXTENSIONS,
  DEFAULT_OOXML_ZIP_EXTENSIONS,
} from "./attachment";
import { getClassifier } from "./classifier";
import { checkDnsbl } from "./dnsbl";
import { extractLinks } from "./links";
import { piiScore } from "./pii";
import { extractSenderIp } from "./received-header";
import { lookupRoute } from "./routing";
import {
  combineScores,
  contentScore,
  DEFAULT_SIGNAL_WEIGHTS,
  DEFAULT_SUSPICIOUS_TLDS,
  dnsblScore,
  headerScore,
  isSpam,
  isValidScores,
  type Scores,
  urlScore,
} from "./scoring";

export interface Env {
  ROUTES: KVNamespace;
  DEFAULT_THRESHOLD: string;
  SIGNAL_WEIGHTS: string;
  REJECT_MESSAGE: string;
  /** Optional: free Spamhaus DQS key. DNSBL check is skipped (scored neutral) when unset. */
  SPAMHAUS_DQS_KEY?: string;
  /** Optional JSON-array overrides for the built-in lists; falls back to defaults when unset/invalid. */
  SUSPICIOUS_TLDS?: string;
  DANGEROUS_EXTENSIONS?: string;
  MACRO_EXTENSIONS?: string;
  OOXML_ZIP_EXTENSIONS?: string;
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

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const route = await lookupRoute(env.ROUTES, message.to);
    if (!route) {
      // No ROUTES entry means this address isn't meant to be handled by
      // this worker at all — misconfigured Email Routing rule, most likely.
      message.setReject("Recipient not configured");
      return;
    }

    const rawBuffer = await new Response(message.raw).arrayBuffer();
    const email = await PostalMime.parse(rawBuffer);

    const headerFrom = email.from?.address ?? message.from;

    const content = contentScore(
      getClassifier(),
      `${email.subject ?? ""}\n${email.text ?? email.html ?? ""}`,
    );

    const fromDomain = headerFrom.split("@")[1] ?? "";
    const url = urlScore(extractLinks(email.html, email.text), fromDomain, {
      suspiciousTlds: parseSet(env.SUSPICIOUS_TLDS, DEFAULT_SUSPICIOUS_TLDS),
    });

    const attachment = attachmentScore(email.attachments, {
      dangerousExtensions: parseSet(
        env.DANGEROUS_EXTENSIONS,
        DEFAULT_DANGEROUS_EXTENSIONS,
      ),
      macroExtensions: parseSet(env.MACRO_EXTENSIONS, DEFAULT_MACRO_EXTENSIONS),
      ooxmlZipExtensions: parseSet(
        env.OOXML_ZIP_EXTENSIONS,
        DEFAULT_OOXML_ZIP_EXTENSIONS,
      ),
    });

    const header = headerScore({
      date: email.date,
      from: headerFrom,
      replyTo: email.replyTo?.[0]?.address,
      subject: email.subject,
    });

    const topReceived = email.headers.find(
      (h) => h.key.toLowerCase() === "received",
    )?.value;
    const senderIp = extractSenderIp(topReceived);
    const dnsblResult = await checkDnsbl(senderIp, env.SPAMHAUS_DQS_KEY);
    const dnsbl = dnsblScore(dnsblResult);

    const pii = piiScore(email.text ?? "");

    const scores: Scores = { content, url, header, dnsbl, attachment, pii };
    const weights = parseWeights(env.SIGNAL_WEIGHTS);
    const score = combineScores(scores, weights);
    const threshold = route.threshold ?? Number(env.DEFAULT_THRESHOLD);
    const spam = isSpam(score, threshold);

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
        verdict: spam ? "reject" : "forward",
      }),
    );

    if (spam) {
      message.setReject(env.REJECT_MESSAGE);
      return;
    }

    for (const destination of route.destinations) {
      await message.forward(destination);
    }
  },
};
