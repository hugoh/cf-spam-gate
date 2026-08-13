import { describe, expect, it } from "vitest";
import { extractSenderIp } from "../src/received-header";

describe("extractSenderIp", () => {
  it("extracts a bracketed IP from a 'from host [ip]' Received header", () => {
    const header =
      "from mail.example.com [203.0.113.7] by mx.cloudflare.net with ESMTP id abc123";
    expect(extractSenderIp(header)).toBe("203.0.113.7");
  });

  it("extracts an IP given in parentheses", () => {
    const header =
      "from mail.example.com (mail.example.com [198.51.100.9]) by mx.cloudflare.net";
    expect(extractSenderIp(header)).toBe("198.51.100.9");
  });

  it("returns undefined when there's no IP literal in the header", () => {
    expect(
      extractSenderIp("from mail.example.com by mx.cloudflare.net"),
    ).toBeUndefined();
  });

  it("returns undefined for an undefined header", () => {
    expect(extractSenderIp(undefined)).toBeUndefined();
  });

  it("extracts a bracketed IPv6 address", () => {
    expect(
      extractSenderIp(
        "from mail.example.com [2001:db8::1] by mx.cloudflare.net",
      ),
    ).toBe("2001:db8::1");
  });

  it("prefers a bracketed literal over an incidental bare-digit run elsewhere in the header", () => {
    const header = "from mail.example.com (id 12345) [2001:db8::1]";
    expect(extractSenderIp(header)).toBe("2001:db8::1");
  });
});
