const RESULT_RE = /\b(spf|dkim)=([a-z]+)/gi;

export interface AuthResults {
  spf?: string;
  dkim?: string;
}

/**
 * Parses Cloudflare's own Authentication-Results header (added to every
 * message that reaches this worker) into the spf/dkim verdicts it recorded.
 * Only the first result for each mechanism is kept — a message can carry
 * multiple DKIM signatures, and we only trust the outcome Cloudflare itself
 * evaluated at the top of the header stack.
 */
export function parseAuthenticationResults(
  header: string | undefined,
): AuthResults {
  if (!header) return {};

  const results: AuthResults = {};
  for (const match of header.matchAll(RESULT_RE)) {
    const mechanism = match[1].toLowerCase() as "spf" | "dkim";
    if (results[mechanism] === undefined) {
      results[mechanism] = match[2].toLowerCase();
    }
  }
  return results;
}
