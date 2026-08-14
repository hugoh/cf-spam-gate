import remove from "confusables";
import { parse } from "tldts";
import type { ExtractedLink } from "./links";

// No SPF/DKIM/DMARC scoring here: Cloudflare Email Routing already rejects
// at the SMTP layer, before this worker ever runs, unless SPF-or-DKIM
// passes and any published DMARC policy is honored — re-checking that in
// the worker would just duplicate a gate that already ran. See README
// "How it works" for the full breakdown of what Cloudflare's built-in
// layer covers vs. what this worker adds on top.

interface Classifier {
  probabilities(text: string): Array<{ category: string; probability: number }>;
}

/**
 * Normalized probability (0-1) that the naivebayes classifier assigns to
 * the "spam" category. naivebayes.probabilities() returns *log*
 * probabilities (large negative numbers, not values in [0,1]), so this
 * converts via softmax rather than treating them as linear — subtracting
 * the max log value first keeps exp() from underflowing on very negative
 * inputs.
 */
export function contentScore(classifier: Classifier, text: string): number {
  const probs = classifier.probabilities(text);
  if (!probs || probs.length === 0) return 0.5;

  const spamLog = probs.find((p) => p.category === "spam")?.probability;
  const hamLog = probs.find((p) => p.category === "ham")?.probability;
  if (spamLog === undefined || hamLog === undefined) return 0.5;

  const max = Math.max(spamLog, hamLog);
  const spamWeight = Math.exp(spamLog - max);
  const hamWeight = Math.exp(hamLog - max);

  return spamWeight / (spamWeight + hamWeight);
}

export const DEFAULT_SUSPICIOUS_TLDS = new Set([
  "zip",
  "mov",
  "top",
  "xyz",
  "click",
  "link",
  "gq",
  "tk",
  "ml",
  "quest",
  "work",
  "loan",
]);

export interface UrlScoreConfig {
  suspiciousTlds?: Set<string>;
}

function isIpLiteral(hostname: string): boolean {
  const bare = hostname.replace(/^\[/, "").replace(/\]$/, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":");
}

function isConfusable(hostname: string): boolean {
  return remove(hostname) !== hostname;
}

const ANCHOR_DOMAIN_RE = /(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i;

/** The domain an anchor's visible text *claims* to point to, if it looks like a URL/domain at all. */
function claimedDomain(anchorText: string): string | undefined {
  const match = anchorText.match(ANCHOR_DOMAIN_RE);
  if (!match) return undefined;
  return parse(match[1]).domain ?? undefined;
}

/** URL/domain reputation heuristics: suspicious TLDs, IP-literal hosts, punycode/confusable domains, anchor-text/href mismatch, and domain mismatch vs the sender. */
export function urlScore(
  links: ExtractedLink[],
  fromDomain: string,
  config: UrlScoreConfig = {},
): number {
  if (links.length === 0) return 0;

  const suspiciousTlds = config.suspiciousTlds ?? DEFAULT_SUSPICIOUS_TLDS;

  const perLink = links.map(({ url: link, anchorText }) => {
    let score = 0;
    try {
      const url = new URL(link);
      const parsed = parse(link);
      if (parsed.domain && parsed.domain !== fromDomain) score += 0.15;
      if (parsed.publicSuffix && suspiciousTlds.has(parsed.publicSuffix))
        score += 0.3;
      if (isIpLiteral(url.hostname)) score += 0.4;
      if (url.hostname.includes("xn--")) score += 0.4;
      if (isConfusable(url.hostname)) score += 0.4;

      const anchorDomain = anchorText ? claimedDomain(anchorText) : undefined;
      if (anchorDomain && parsed.domain && anchorDomain !== parsed.domain)
        score += 0.4;
    } catch {
      score += 0.2; // unparseable "link" is itself a bad sign
    }
    return Math.min(score, 1);
  });

  return Math.min(perLink.reduce((sum, s) => sum + s, 0) / links.length, 1);
}

export interface Headers {
  date?: string;
  from?: string;
  replyTo?: string;
  subject?: string;
}

function domainOf(address: string | undefined): string | undefined {
  return address?.split("@")[1]?.toLowerCase();
}

function isShoutingSubject(subject: string): boolean {
  const letters = subject.replace(/[^a-zA-Z]/g, "");
  return letters.length > 4 && letters === letters.toUpperCase();
}

/** Lightweight header heuristics: missing/malformed Date, Reply-To/From domain mismatch, shouting subjects. */
export function headerScore(headers: Headers): number {
  let score = 0;

  if (!headers.date || Number.isNaN(Date.parse(headers.date))) score += 0.3;

  if (headers.replyTo && domainOf(headers.replyTo) !== domainOf(headers.from))
    score += 0.3;

  if (headers.subject && isShoutingSubject(headers.subject)) score += 0.4;

  return Math.min(score, 1);
}

export interface Scores {
  content: number;
  url: number;
  header: number;
  dnsbl: number;
  attachment: number;
  pii: number;
}

export const SCORE_KEYS: Array<keyof Scores> = [
  "content",
  "url",
  "header",
  "dnsbl",
  "attachment",
  "pii",
];

export const DEFAULT_SIGNAL_WEIGHTS: Scores = {
  content: 0.5,
  url: 0.25,
  header: 0.1,
  dnsbl: 0.15,
  attachment: 0.2,
  pii: 0.05,
};

export type SignalCategory = "reputation" | "attachment" | "links" | "content";

export const SIGNAL_CATEGORIES: Record<keyof Scores, SignalCategory> = {
  dnsbl: "reputation",
  attachment: "attachment",
  url: "links",
  content: "content",
  header: "content",
  pii: "content",
};

/**
 * Coarse category of whichever signal contributed most to the weighted
 * score — used to pick a reject message that's informative without leaking
 * exact scores/thresholds to an adversary probing the filter.
 */
export function dominantCategory(
  scores: Scores,
  weights: Scores,
): SignalCategory {
  let best: keyof Scores = SCORE_KEYS[0];
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

  for (const key of Object.keys(scores) as Array<keyof Scores>) {
    totalWeight += weights[key];
    weightedSum += scores[key] * weights[key];
  }

  return totalWeight === 0 ? 0 : weightedSum / totalWeight;
}

/** 1 when the connecting IP is on the DNSBL, 0 otherwise — "unknown" (lookup unavailable/skipped) counts as 0, not as evidence of spam. */
export function dnsblScore(result: "listed" | "clean" | "unknown"): number {
  return result === "listed" ? 1 : 0;
}

export function isSpam(score: number, threshold: number): boolean {
  return score >= threshold;
}
