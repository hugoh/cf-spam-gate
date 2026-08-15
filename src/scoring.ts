import remove from "confusables";
import { parse } from "tldts";
import type { AuthResults } from "./auth";
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

/** 1 when the connecting IP is on the DNSBL, 0 otherwise — "unknown" (lookup unavailable/skipped) counts as 0, not as evidence of spam. */
export function dnsblScore(result: "listed" | "clean" | "unknown"): number {
  return result === "listed" ? 1 : 0;
}

export function isSpam(score: number, threshold: number): boolean {
  return score >= threshold;
}

/**
 * Severity of an individual SPF/DKIM verdict from Cloudflare's
 * Authentication-Results header, on a 0 (pass) to 1 (hard fail) scale.
 * `neutral`/`none`/`policy` sit below `softfail`, which sits below an
 * outright `fail` (or a lookup error, which is at least as suspicious as a
 * hard fail). Anything else unrecognized is treated as a soft signal rather
 * than ignored outright.
 */
const AUTH_SEVERITY: Record<string, number> = {
  pass: 0,
  neutral: 0.3,
  none: 0.3,
  policy: 0.3,
  softfail: 0.5,
  fail: 1,
  temperror: 1,
  permerror: 1,
};

function severityOf(result: string | undefined): number {
  if (result === undefined) return 0;
  return AUTH_SEVERITY[result] ?? 0.5;
}

/**
 * Cloudflare's Email Routing already gates on SPF-or-DKIM passing before
 * this worker runs at all (see the note at the top of this file), so a
 * message reaching here has cleared that bar. This signal picks up the
 * gap — e.g. a message that passed on DKIM alone while SPF softfailed —
 * by scoring the worse of the two mechanisms rather than requiring both.
 */
export function authScore(results: AuthResults): number {
  return Math.max(severityOf(results.spf), severityOf(results.dkim));
}
