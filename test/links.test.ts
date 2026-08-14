import { describe, expect, it } from "vitest";
import { extractLinks } from "../src/links";

describe("extractLinks", () => {
  it("extracts href attributes from HTML along with their anchor text", () => {
    const html =
      '<a href="https://example.com/a">click here</a> <a href="https://example.com/b">and here</a>';
    expect(extractLinks(html, undefined)).toEqual([
      { url: "https://example.com/a", anchorText: "click here" },
      { url: "https://example.com/b", anchorText: "and here" },
    ]);
  });

  it("extracts bare URLs from plain text with no anchor text", () => {
    const text =
      "Check this out: https://example.com/a and also http://example.org/b";
    expect(extractLinks(undefined, text)).toEqual([
      { url: "https://example.com/a", anchorText: undefined },
      { url: "http://example.org/b", anchorText: undefined },
    ]);
  });

  it("dedupes links found in both html and text", () => {
    const html = '<a href="https://example.com/a">a</a>';
    const text = "https://example.com/a";
    expect(extractLinks(html, text)).toEqual([
      { url: "https://example.com/a", anchorText: "a" },
    ]);
  });

  it("returns an empty array when there is no html or text", () => {
    expect(extractLinks(undefined, undefined)).toEqual([]);
  });

  it("strips nested tags from anchor text", () => {
    const html = '<a href="https://example.com/a"><b>click</b> me</a>';
    expect(extractLinks(html, undefined)).toEqual([
      { url: "https://example.com/a", anchorText: "click me" },
    ]);
  });

  it("omits anchorText when the link text is empty", () => {
    const html = '<a href="https://example.com/a"></a>';
    expect(extractLinks(html, undefined)).toEqual([
      { url: "https://example.com/a", anchorText: undefined },
    ]);
  });

  it("extracts the href even when the anchor tag is never closed", () => {
    const html =
      '<a href="http://evil.example/phish">Click here to verify your account';
    expect(extractLinks(html, undefined)).toEqual([
      {
        url: "http://evil.example/phish",
        anchorText: "Click here to verify your account",
      },
    ]);
  });
});
