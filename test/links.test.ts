import { describe, expect, it } from "vitest";
import { extractLinks } from "../src/links";

describe("extractLinks", () => {
  it("extracts href attributes from HTML", () => {
    const html =
      '<a href="https://example.com/a">click</a> <a href="https://example.com/b">here</a>';
    expect(extractLinks(html, undefined)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("extracts bare URLs from plain text", () => {
    const text =
      "Check this out: https://example.com/a and also http://example.org/b";
    expect(extractLinks(undefined, text)).toEqual([
      "https://example.com/a",
      "http://example.org/b",
    ]);
  });

  it("dedupes links found in both html and text", () => {
    const html = '<a href="https://example.com/a">a</a>';
    const text = "https://example.com/a";
    expect(extractLinks(html, text)).toEqual(["https://example.com/a"]);
  });

  it("returns an empty array when there is no html or text", () => {
    expect(extractLinks(undefined, undefined)).toEqual([]);
  });
});
