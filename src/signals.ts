import type { Email as ParsedEmail } from "postal-mime";
import { attachmentScore } from "./attachment";
import { parseAuthenticationResults } from "./auth";
import { getClassifier } from "./classifier";
import type { DnsblResult } from "./dnsbl";
import { extractLinks } from "./links";
import { piiScore } from "./pii";
import {
  authScore,
  contentScore,
  dnsblScore,
  headerScore,
  urlScore,
} from "./scoring";

/**
 * Everything a signal's `compute` needs, pre-resolved by the caller (env
 * parsing, header extraction, the DNSBL fetch) so signals themselves stay
 * pure and don't each need to know about `Env`.
 */
export interface SignalContext {
  email: ParsedEmail;
  headerFrom: string;
  fromDomain: string;
  suspiciousTlds: Set<string>;
  dangerousExtensions: Set<string>;
  macroExtensions: Set<string>;
  ooxmlZipExtensions: Set<string>;
  /** Kicked off as early as possible by the caller so it overlaps with the other signals instead of blocking them. */
  dnsblResult: Promise<DnsblResult>;
}

export type SignalCategory = "reputation" | "attachment" | "links" | "content";

/**
 * One spam signal: how to compute its 0-1 score, its default weight, and
 * the coarse category used to pick a reject message. Adding a signal means
 * adding an entry here — every other piece (Scores' shape, default
 * weights, config validation, dominant-category lookup, stats'
 * per-signal breakdown) is derived from this list.
 */
export interface Signal {
  key: string;
  category: SignalCategory;
  defaultWeight: number;
  compute(ctx: SignalContext): number | Promise<number>;
}

export const SIGNALS = [
  {
    key: "content",
    category: "content",
    defaultWeight: 0.2,
    compute: (ctx) =>
      contentScore(
        getClassifier(),
        `${ctx.email.subject ?? ""}\n${ctx.email.text ?? ctx.email.html ?? ""}`,
      ),
  },
  {
    key: "url",
    category: "links",
    defaultWeight: 0.15,
    compute: (ctx) =>
      urlScore(extractLinks(ctx.email.html, ctx.email.text), ctx.fromDomain, {
        suspiciousTlds: ctx.suspiciousTlds,
      }),
  },
  {
    key: "header",
    category: "content",
    defaultWeight: 0.05,
    compute: (ctx) =>
      headerScore({
        date: ctx.email.date,
        from: ctx.headerFrom,
        replyTo: ctx.email.replyTo?.[0]?.address,
        subject: ctx.email.subject,
      }),
  },
  {
    key: "dnsbl",
    category: "reputation",
    defaultWeight: 0.3,
    compute: async (ctx) => dnsblScore(await ctx.dnsblResult),
  },
  {
    key: "attachment",
    category: "attachment",
    defaultWeight: 0.1,
    compute: (ctx) =>
      attachmentScore(ctx.email.attachments, {
        dangerousExtensions: ctx.dangerousExtensions,
        macroExtensions: ctx.macroExtensions,
        ooxmlZipExtensions: ctx.ooxmlZipExtensions,
      }),
  },
  {
    key: "pii",
    category: "content",
    defaultWeight: 0.05,
    compute: (ctx) => piiScore(ctx.email.text ?? ""),
  },
  {
    key: "auth",
    category: "reputation",
    defaultWeight: 0.25,
    compute: (ctx) => {
      const authResultsHeader = ctx.email.headers.find(
        (h) => h.key.toLowerCase() === "authentication-results",
      )?.value;
      return authScore(parseAuthenticationResults(authResultsHeader));
    },
  },
] as const satisfies readonly Signal[];

export type SignalKey = (typeof SIGNALS)[number]["key"];

export type Scores = Record<SignalKey, number>;

export const SCORE_KEYS = SIGNALS.map((s) => s.key) as SignalKey[];

export const DEFAULT_SIGNAL_WEIGHTS: Scores = Object.fromEntries(
  SIGNALS.map((s) => [s.key, s.defaultWeight]),
) as Scores;

export const SIGNAL_CATEGORIES: Record<SignalKey, SignalCategory> =
  Object.fromEntries(SIGNALS.map((s) => [s.key, s.category])) as Record<
    SignalKey,
    SignalCategory
  >;

/** Runs every registered signal concurrently and assembles the results into a Scores object. Signals that don't await anything (most of them) resolve in the same tick; `dnsbl` overlaps with the rest via ctx.dnsblResult. */
export async function computeScores(ctx: SignalContext): Promise<Scores> {
  const values = await Promise.all(
    SIGNALS.map((signal) => Promise.resolve(signal.compute(ctx))),
  );
  return Object.fromEntries(
    SIGNALS.map((signal, i) => [signal.key, values[i]]),
  ) as Scores;
}

/**
 * Coarse category of whichever signal contributed most to the weighted
 * score — used to pick a reject message that's informative without leaking
 * exact scores/thresholds to an adversary probing the filter.
 */
export function dominantCategory(
  scores: Scores,
  weights: Scores,
): SignalCategory {
  let best: SignalKey = SCORE_KEYS[0];
  let bestContribution = -1;

  for (const key of SCORE_KEYS) {
    const contribution = scores[key] * weights[key];
    if (contribution > bestContribution) {
      bestContribution = contribution;
      best = key;
    }
  }

  return SIGNAL_CATEGORIES[best];
}

/** True when `value` has exactly the Scores shape: every key present as a finite, non-negative number. */
export function isValidScores(value: unknown): value is Scores {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return SCORE_KEYS.every((key) => {
    const n = record[key];
    return typeof n === "number" && Number.isFinite(n) && n >= 0;
  });
}

/** Weighted average of the signal scores, normalizing weights that don't sum to 1. */
export function combineScores(scores: Scores, weights: Scores): number {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const key of SCORE_KEYS) {
    totalWeight += weights[key];
    weightedSum += scores[key] * weights[key];
  }

  return totalWeight === 0 ? 0 : weightedSum / totalWeight;
}
