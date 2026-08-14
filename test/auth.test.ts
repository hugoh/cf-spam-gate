import { describe, expect, it } from "vitest";
import { parseAuthenticationResults } from "../src/auth";

describe("parseAuthenticationResults", () => {
  it("extracts spf and dkim verdicts from a well-formed header", () => {
    const header =
      "mx.cloudflare.net; spf=softfail (mx.cloudflare.net: domain of x@example.com does not designate permitted sender) smtp.mailfrom=x@example.com; dkim=pass header.d=example.com; dmarc=none header.from=example.com; arc=none";
    expect(parseAuthenticationResults(header)).toEqual({
      spf: "softfail",
      dkim: "pass",
    });
  });

  it("returns an empty object for an undefined header", () => {
    expect(parseAuthenticationResults(undefined)).toEqual({});
  });

  it("returns an empty object when spf/dkim results aren't present", () => {
    expect(parseAuthenticationResults("mx.cloudflare.net; dmarc=none")).toEqual(
      {},
    );
  });

  it("keeps only the first result per mechanism", () => {
    const header = "spf=pass smtp.mailfrom=a; spf=fail smtp.mailfrom=b";
    expect(parseAuthenticationResults(header)).toEqual({ spf: "pass" });
  });

  it("is case-insensitive", () => {
    expect(parseAuthenticationResults("SPF=PASS; DKIM=Fail")).toEqual({
      spf: "pass",
      dkim: "fail",
    });
  });
});
