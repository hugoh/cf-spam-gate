import { describe, expect, it } from "vitest";
import { piiScore } from "../src/pii";

describe("piiScore", () => {
  it("is 0 for text with no digit sequences", () => {
    expect(piiScore("Hi, just checking in about tomorrow's meeting.")).toBe(0);
  });

  it("is 1 when the text contains a Luhn-valid card number", () => {
    // 4111 1111 1111 1111 is the standard Visa test number, Luhn-valid.
    expect(
      piiScore("Please confirm your card 4111 1111 1111 1111 to continue."),
    ).toBe(1);
  });

  it("is 1 for a Luhn-valid card number with no separators", () => {
    expect(piiScore("Card: 4111111111111111")).toBe(1);
  });

  it("is 1 for a Luhn-valid card number with dash separators", () => {
    expect(piiScore("4111-1111-1111-1111")).toBe(1);
  });

  it("is 0 for a digit sequence that fails the Luhn checksum", () => {
    expect(piiScore("Reference number: 1234 5678 9012 3456")).toBe(0);
  });

  it("is 0 for a short digit sequence like a phone number", () => {
    expect(piiScore("Call us at 555-123-4567")).toBe(0);
  });
});
