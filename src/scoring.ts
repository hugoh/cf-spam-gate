import { parse } from "tldts";

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

const SUSPICIOUS_TLDS = new Set([
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

function isIpLiteral(hostname: string): boolean {
  const bare = hostname.replace(/^\[/, "").replace(/\]$/, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":");
}

/** URL/domain reputation heuristics: suspicious TLDs, IP-literal hosts, punycode, and domain mismatch vs the sender. */
export function urlScore(links: string[], fromDomain: string): number {
  if (links.length === 0) return 0;

  const perLink = links.map((link) => {
    let score = 0;
    try {
      const url = new URL(link);
      const parsed = parse(link);
      if (parsed.domain && parsed.domain !== fromDomain) score += 0.15;
      if (parsed.publicSuffix && SUSPICIOUS_TLDS.has(parsed.publicSuffix))
        score += 0.3;
      if (isIpLiteral(url.hostname)) score += 0.4;
      if (url.hostname.includes("xn--")) score += 0.4;
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
}

/** Weighted average of the four signal scores, normalizing weights that don't sum to 1. */
export function combineScores(scores: Scores, weights: Scores): number {
  const totalWeight =
    weights.content + weights.url + weights.header + weights.dnsbl;
  if (totalWeight === 0) return 0;

  const weightedSum =
    scores.content * weights.content +
    scores.url * weights.url +
    scores.header * weights.header +
    scores.dnsbl * weights.dnsbl;

  return weightedSum / totalWeight;
}

/** 1 when the connecting IP is on the DNSBL, 0 otherwise — "unknown" (lookup unavailable/skipped) counts as 0, not as evidence of spam. */
export function dnsblScore(result: "listed" | "clean" | "unknown"): number {
  return result === "listed" ? 1 : 0;
}

export function isSpam(score: number, threshold: number): boolean {
  return score >= threshold;
}
