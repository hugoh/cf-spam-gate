/**
 * Optional DNSBL check against Spamhaus's Data Query Service (DQS), using
 * the connecting client's IP (best-effort, from the top Received header —
 * see received-header.ts). DQS is used instead of the legacy public
 * zen.spamhaus.org zone because Spamhaus silently returns "not listed" for
 * queries relayed through major public resolvers (Cloudflare's own
 * 1.1.1.1 included) — DQS ties authorization to a registered key instead
 * of the querying resolver's identity, so it works reliably from a Worker.
 * Requires a free Spamhaus DQS key; the check is skipped (returns
 * "unknown") when no key is configured or no sender IP could be found.
 */

import ipPtr from "ip-ptr";

export type DnsblResult = "listed" | "clean" | "unknown";

/** ip-ptr gives us "<reversed>.in-addr.arpa" (v4) or "<reversed>.ip6.arpa" (v6); we just want the reversed part. */
function reversedLabels(ip: string): string {
  return ipPtr(ip).replace(/\.(in-addr|ip6)\.arpa$/, "");
}

export async function checkDnsbl(
  ip: string | undefined,
  dqsKey: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<DnsblResult> {
  if (!ip || !dqsKey) return "unknown";

  try {
    const name = `${reversedLabels(ip)}.${dqsKey}.zen.dq.spamhaus.net`;
    const response = await fetchFn(
      `https://cloudflare-dns.com/dns-query?name=${name}&type=A`,
      {
        headers: { accept: "application/dns-json" },
      },
    );
    if (!response.ok) return "unknown";

    const body = (await response.json()) as { Answer?: unknown[] };
    return (body.Answer?.length ?? 0) > 0 ? "listed" : "clean";
  } catch {
    return "unknown";
  }
}
