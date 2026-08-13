import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkDnsbl } from "../src/dnsbl";

function dohResponse(answer: unknown[]) {
  return new Response(JSON.stringify({ Status: 0, Answer: answer }), {
    status: 200,
  });
}

describe("checkDnsbl", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  function asFetch(): typeof fetch {
    return fetchMock as unknown as typeof fetch;
  }

  it("queries the reversed-octet name under the DQS key's zone for an IPv4 address", async () => {
    fetchMock.mockResolvedValue(dohResponse([]));

    await checkDnsbl("203.0.113.7", "mydqskey", asFetch());

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloudflare-dns.com/dns-query?name=7.113.0.203.mydqskey.zen.dq.spamhaus.net&type=A",
      expect.anything(),
    );
  });

  it("queries the nibble-reversed name under the DQS key's zone for an IPv6 address", async () => {
    fetchMock.mockResolvedValue(dohResponse([]));

    await checkDnsbl("2001:db8::1", "mydqskey", asFetch());

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://cloudflare-dns.com/dns-query?name=1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.mydqskey.zen.dq.spamhaus.net&type=A",
    );
  });

  it("returns 'listed' when the zone answers with an A record", async () => {
    fetchMock.mockResolvedValue(
      dohResponse([{ name: "x", type: 1, TTL: 60, data: "127.0.0.2" }]),
    );

    expect(await checkDnsbl("203.0.113.7", "mydqskey", asFetch())).toBe(
      "listed",
    );
  });

  it("returns 'clean' on NXDOMAIN (no answer)", async () => {
    fetchMock.mockResolvedValue(dohResponse([]));

    expect(await checkDnsbl("203.0.113.7", "mydqskey", asFetch())).toBe(
      "clean",
    );
  });

  it("returns 'unknown' without making a request when no IP is available", async () => {
    expect(await checkDnsbl(undefined, "mydqskey", asFetch())).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 'unknown' without making a request when no DQS key is configured", async () => {
    expect(await checkDnsbl("203.0.113.7", undefined, asFetch())).toBe(
      "unknown",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 'unknown' (fails safe) when the lookup itself errors", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));

    expect(await checkDnsbl("203.0.113.7", "mydqskey", asFetch())).toBe(
      "unknown",
    );
  });
});
