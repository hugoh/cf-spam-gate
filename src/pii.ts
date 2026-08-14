import luhnValid from "fast-luhn";

const CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;

/** PII/credit-card detection: flags text containing a Luhn-valid card-number-shaped digit sequence. */
export function piiScore(text: string): number {
  for (const match of text.matchAll(CANDIDATE_RE)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits))
      return 1;
  }
  return 0;
}
