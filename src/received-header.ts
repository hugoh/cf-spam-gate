const BRACKETED_RE = /\[([0-9a-fA-F.:]+)]/;
const BARE_IPV4_RE = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;

/**
 * Best-effort extraction of the connecting client's IP from the topmost
 * Received header — the one prepended by whichever MTA accepted the
 * connection closest to us (normally Cloudflare's own receiving edge).
 * Workers' email() handler doesn't expose the connecting IP directly, so
 * this is the only source available for a DNSBL lookup.
 */
export function extractSenderIp(
  topReceivedHeader: string | undefined,
): string | undefined {
  if (!topReceivedHeader) return undefined;
  return (
    BRACKETED_RE.exec(topReceivedHeader)?.[1] ??
    BARE_IPV4_RE.exec(topReceivedHeader)?.[1]
  );
}
