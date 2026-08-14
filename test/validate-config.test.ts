import { describe, expect, it } from "vitest";
import { validateVars } from "../scripts/validate-config.mjs";

const validWeights = JSON.stringify({
  content: 0.35,
  url: 0.2,
  header: 0.05,
  dnsbl: 0.1,
  attachment: 0.25,
  pii: 0.05,
});

describe("validateVars", () => {
  it("is valid for well-formed SIGNAL_WEIGHTS and no list overrides", () => {
    expect(validateVars({ SIGNAL_WEIGHTS: validWeights })).toEqual([]);
  });

  it("errors when SIGNAL_WEIGHTS is missing", () => {
    expect(validateVars({})).toEqual([
      "SIGNAL_WEIGHTS is missing from [vars].",
    ]);
  });

  it("errors when SIGNAL_WEIGHTS is not valid JSON", () => {
    const errors = validateVars({ SIGNAL_WEIGHTS: "{not json" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/SIGNAL_WEIGHTS is not valid JSON/);
  });

  it("errors when SIGNAL_WEIGHTS is missing a key", () => {
    const weights = JSON.parse(validWeights);
    delete weights.pii;
    const errors = validateVars({ SIGNAL_WEIGHTS: JSON.stringify(weights) });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/SIGNAL_WEIGHTS must have exactly the keys/);
  });

  it("errors when SIGNAL_WEIGHTS has a negative weight", () => {
    const weights = { ...JSON.parse(validWeights), url: -1 };
    const errors = validateVars({ SIGNAL_WEIGHTS: JSON.stringify(weights) });
    expect(errors).toHaveLength(1);
  });

  it("is valid when an optional list override is a JSON string array", () => {
    expect(
      validateVars({
        SIGNAL_WEIGHTS: validWeights,
        SUSPICIOUS_TLDS: JSON.stringify(["zip", "top"]),
      }),
    ).toEqual([]);
  });

  it("errors when an optional list override isn't an array of strings", () => {
    const errors = validateVars({
      SIGNAL_WEIGHTS: validWeights,
      DANGEROUS_EXTENSIONS: JSON.stringify({ not: "an array" }),
    });
    expect(errors).toEqual([
      "DANGEROUS_EXTENSIONS must be a JSON array of strings.",
    ]);
  });

  it("collects multiple errors at once", () => {
    const errors = validateVars({
      MACRO_EXTENSIONS: "{bad json",
    });
    expect(errors).toHaveLength(2);
  });

  it("is valid when REJECT_MESSAGES is a JSON object with known category keys", () => {
    expect(
      validateVars({
        SIGNAL_WEIGHTS: validWeights,
        REJECT_MESSAGES: JSON.stringify({
          reputation: "Sender is blocklisted.",
          attachment: "Attachment type not allowed.",
        }),
      }),
    ).toEqual([]);
  });

  it("errors when REJECT_MESSAGES has an unknown category key", () => {
    const errors = validateVars({
      SIGNAL_WEIGHTS: validWeights,
      REJECT_MESSAGES: JSON.stringify({ bogus: "nope" }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/REJECT_MESSAGES must be a JSON object/);
  });

  it("errors when REJECT_MESSAGES isn't valid JSON", () => {
    const errors = validateVars({
      SIGNAL_WEIGHTS: validWeights,
      REJECT_MESSAGES: "{not json",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/REJECT_MESSAGES is not valid JSON/);
  });

  it("is valid when STATS_ENABLED and retention vars are well-formed", () => {
    expect(
      validateVars({
        SIGNAL_WEIGHTS: validWeights,
        STATS_ENABLED: "true",
        STATS_HOUR_RETENTION_DAYS: "30",
        STATS_DAY_RETENTION_DAYS: "400",
      }),
    ).toEqual([]);
  });

  it('errors when STATS_ENABLED isn\'t "true" or "false"', () => {
    const errors = validateVars({
      SIGNAL_WEIGHTS: validWeights,
      STATS_ENABLED: "yes",
    });
    expect(errors).toEqual(['STATS_ENABLED must be "true" or "false".']);
  });

  it("errors when a stats retention var isn't a positive integer", () => {
    const errors = validateVars({
      SIGNAL_WEIGHTS: validWeights,
      STATS_HOUR_RETENTION_DAYS: "0",
      STATS_DAY_RETENTION_DAYS: "abc",
    });
    expect(errors).toEqual([
      "STATS_HOUR_RETENTION_DAYS must be a positive integer.",
      "STATS_DAY_RETENTION_DAYS must be a positive integer.",
    ]);
  });
});
