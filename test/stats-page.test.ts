import { describe, expect, it } from "vitest";
import { renderStatsPage } from "../src/stats-page";

describe("renderStatsPage", () => {
  it("renders a row per bucket with signal counts", () => {
    const html = renderStatsPage("hour", [
      {
        key: "2026-08-14T09",
        total: 3,
        spam: 1,
        forwarded: 2,
        signals: { content: 1, dnsbl: 0 },
      },
    ]);

    expect(html).toContain("2026-08-14T09");
    expect(html).toContain("<td>3</td>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<td>2</td>");
    expect(html).toContain("content: 1");
    expect(html).not.toContain("dnsbl"); // zero-count signals are omitted
  });

  it("shows a placeholder row when there are no buckets", () => {
    const html = renderStatsPage("day", []);
    expect(html).toContain("No data yet.");
  });

  it("links to the other granularity and the raw JSON endpoint", () => {
    const html = renderStatsPage("hour", []);
    expect(html).toContain('href="?granularity=day"');
    expect(html).toContain('href="/stats.json?granularity=hour"');
  });

  it("escapes bucket keys and signal names", () => {
    const html = renderStatsPage("hour", [
      {
        key: "<script>",
        total: 1,
        spam: 0,
        forwarded: 1,
        signals: {},
      },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
