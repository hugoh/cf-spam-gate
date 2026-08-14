const CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/** PII/credit-card detection: flags text containing a Luhn-valid card-number-shaped digit sequence. */
export function piiScore(text: string): number {
  for (const match of text.matchAll(CANDIDATE_RE)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits))
      return 1;
  }
  return 0;
}
