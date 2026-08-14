import { describe, expect, it } from "vitest";
import {
  combineScores,
  contentScore,
  dnsblScore,
  headerScore,
  isSpam,
  isValidScores,
  urlScore,
} from "../src/scoring";

describe("contentScore", () => {
  // naivebayes.probabilities() returns *log* probabilities (large negative
  // numbers), not linear values in [0,1] — these fixtures reflect that.
  it("is close to 1 when the spam log-probability is much higher (less negative) than ham's", () => {
    const classifier = {
      probabilities: () => [
        { category: "spam", probability: -10 },
        { category: "ham", probability: -50 },
      ],
    };
    expect(contentScore(classifier, "buy now")).toBeCloseTo(1, 5);
  });

  it("is close to 0 when the ham log-probability is much higher than spam's", () => {
    const classifier = {
      probabilities: () => [
        { category: "spam", probability: -50 },
        { category: "ham", probability: -10 },
      ],
    };
    expect(contentScore(classifier, "buy now")).toBeCloseTo(0, 5);
  });

  it("is 0.5 when spam and ham are equally likely", () => {
    const classifier = {
      probabilities: () => [
        { category: "spam", probability: -20 },
        { category: "ham", probability: -20 },
      ],
    };
    expect(contentScore(classifier, "buy now")).toBeCloseTo(0.5);
  });

  it("doesn't underflow to NaN on very large-magnitude log-probabilities", () => {
    const classifier = {
      probabilities: () => [
        { category: "spam", probability: -301.67 },
        { category: "ham", probability: -332.32 },
      ],
    };
    expect(contentScore(classifier, "buy now")).toBeCloseTo(1, 5);
  });

  it("returns 0.5 (unknown) when the classifier has no data for either category", () => {
    const classifier = { probabilities: () => [] };
    expect(contentScore(classifier, "")).toBe(0.5);
  });
});

describe("urlScore", () => {
  it("is 0 for no links", () => {
    expect(urlScore([], "example.com")).toBe(0);
  });

  it("is 0 when all links share the sender's domain", () => {
    expect(
      urlScore(
        [{ url: "https://example.com/a" }, { url: "https://example.com/b" }],
        "example.com",
      ),
    ).toBe(0);
  });

  it("increases for links to suspicious/free TLDs", () => {
    expect(
      urlScore([{ url: "https://free-prize.zip/claim" }], "example.com"),
    ).toBeGreaterThan(0);
  });

  it("honors a custom suspicious-TLD config over the default list", () => {
    expect(
      urlScore([{ url: "https://free-prize.zip/claim" }], "free-prize.zip", {
        suspiciousTlds: new Set(),
      }),
    ).toBe(0);
    expect(
      urlScore([{ url: "https://shop.example.dev/" }], "example.com", {
        suspiciousTlds: new Set(["dev"]),
      }),
    ).toBeGreaterThan(0);
  });

  it("increases for IP-literal links", () => {
    expect(
      urlScore([{ url: "http://192.0.2.1/login" }], "example.com"),
    ).toBeGreaterThan(0);
  });

  it("increases for punycode/homograph domains", () => {
    expect(
      urlScore([{ url: "https://xn--pple-43d.com/" }], "example.com"),
    ).toBeGreaterThan(0);
  });

  it("increases for Unicode-confusable domains", () => {
    // Cyrillic "а" (U+0430) standing in for Latin "a" in "apple.com"
    expect(
      urlScore([{ url: "https://аpple.com/" }], "example.com"),
    ).toBeGreaterThan(0);
  });

  it("increases when anchor text shows a different domain than the href", () => {
    expect(
      urlScore(
        [
          {
            url: "https://evil-phish.com/login",
            anchorText: "https://mybank.com/login",
          },
        ],
        "example.com",
      ),
    ).toBeGreaterThan(0);
  });

  it("does not flag anchor text that matches the href's domain", () => {
    expect(
      urlScore(
        [
          {
            url: "https://mybank.com/login",
            anchorText: "https://mybank.com/login",
          },
        ],
        "mybank.com",
      ),
    ).toBe(0);
  });

  it("does not flag anchor text that isn't itself a URL/domain", () => {
    expect(
      urlScore(
        [{ url: "https://mybank.com/login", anchorText: "click here" }],
        "mybank.com",
      ),
    ).toBe(0);
  });
});

describe("headerScore", () => {
  it("is 0 for a well-formed, consistent header set", () => {
    const score = headerScore({
      date: new Date().toUTCString(),
      from: "person@example.com",
      replyTo: "person@example.com",
      subject: "Weekly update",
    });
    expect(score).toBe(0);
  });

  it("increases when Date is missing", () => {
    expect(
      headerScore({ from: "person@example.com", subject: "hi" }),
    ).toBeGreaterThan(0);
  });

  it("increases when Reply-To domain differs from From domain", () => {
    const score = headerScore({
      date: new Date().toUTCString(),
      from: "person@example.com",
      replyTo: "totally-different@other.com",
      subject: "hi",
    });
    expect(score).toBeGreaterThan(0);
  });

  it("increases for ALL CAPS subjects", () => {
    const score = headerScore({
      date: new Date().toUTCString(),
      from: "person@example.com",
      subject: "ACT NOW BEFORE ITS TOO LATE",
    });
    expect(score).toBeGreaterThan(0);
  });
});

describe("dnsblScore", () => {
  it("is 1 when listed", () => {
    expect(dnsblScore("listed")).toBe(1);
  });

  it("is 0 when clean", () => {
    expect(dnsblScore("clean")).toBe(0);
  });

  it("is 0 when unknown — absence of evidence isn't evidence of spam", () => {
    expect(dnsblScore("unknown")).toBe(0);
  });
});

describe("combineScores", () => {
  it("computes the weighted average of all signals", () => {
    const score = combineScores(
      { content: 1, url: 0, header: 0, dnsbl: 0, attachment: 0, pii: 0 },
      {
        content: 0.35,
        url: 0.2,
        header: 0.05,
        dnsbl: 0.1,
        attachment: 0.25,
        pii: 0.05,
      },
    );
    expect(score).toBeCloseTo(0.35);
  });

  it("normalizes weights that don't sum to 1", () => {
    const score = combineScores(
      { content: 1, url: 1, header: 0, dnsbl: 0, attachment: 0, pii: 0 },
      { content: 1, url: 1, header: 0, dnsbl: 0, attachment: 0, pii: 0 },
    );
    expect(score).toBeCloseTo(1);
  });

  it("weighs a new signal (e.g. attachment) the same as any other", () => {
    const score = combineScores(
      { content: 0, url: 0, header: 0, dnsbl: 0, attachment: 1, pii: 0 },
      { content: 0, url: 0, header: 0, dnsbl: 0, attachment: 1, pii: 0 },
    );
    expect(score).toBeCloseTo(1);
  });
});

describe("isValidScores", () => {
  const valid = {
    content: 0.35,
    url: 0.2,
    header: 0.05,
    dnsbl: 0.1,
    attachment: 0.25,
    pii: 0.05,
  };

  it("is true for a well-formed Scores object", () => {
    expect(isValidScores(valid)).toBe(true);
  });

  it("is false when a key is missing", () => {
    const { pii, ...rest } = valid;
    expect(isValidScores(rest)).toBe(false);
  });

  it("is false when a value is non-numeric", () => {
    expect(isValidScores({ ...valid, content: "high" })).toBe(false);
  });

  it("is false when a value is negative", () => {
    expect(isValidScores({ ...valid, url: -0.1 })).toBe(false);
  });

  it("is false when a value is NaN or Infinity", () => {
    expect(isValidScores({ ...valid, header: Number.NaN })).toBe(false);
    expect(isValidScores({ ...valid, header: Number.POSITIVE_INFINITY })).toBe(
      false,
    );
  });

  it("is false for null, arrays, and non-objects", () => {
    expect(isValidScores(null)).toBe(false);
    expect(isValidScores([])).toBe(false);
    expect(isValidScores("nope")).toBe(false);
  });
});

describe("isSpam", () => {
  it("is true when the score meets or exceeds the threshold", () => {
    expect(isSpam(0.5, 0.5)).toBe(true);
    expect(isSpam(0.6, 0.5)).toBe(true);
  });

  it("is false when the score is below the threshold", () => {
    expect(isSpam(0.4, 0.5)).toBe(false);
  });
});
