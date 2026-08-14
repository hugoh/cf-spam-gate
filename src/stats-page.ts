import html from "html-template-tag";
import type { StatsBucket } from "./stats-do";

function formatSignals(signals: StatsBucket["signals"]): string {
  const entries = Object.entries(signals).filter(([, count]) => count > 0);
  if (entries.length === 0) return "—";
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}: ${count}`)
    .join(", ");
}

function bucketRow(bucket: StatsBucket): string {
  return html`<tr>
    <td>${bucket.key}</td>
    <td>${String(bucket.total)}</td>
    <td>${String(bucket.spam)}</td>
    <td>${String(bucket.forwarded)}</td>
    <td>${String(bucket.failed)}</td>
    <td>${formatSignals(bucket.signals)}</td>
  </tr>`;
}

/** Renders a minimal, dependency-light HTML page for the stats buckets. */
export function renderStatsPage(
  granularity: "hour" | "day",
  buckets: StatsBucket[],
): string {
  const otherGranularity = granularity === "hour" ? "day" : "hour";
  // Passed as an array (not joined into one string) so html-template-tag
  // treats each row as already-safe markup instead of re-escaping it.
  const rows =
    buckets.length > 0
      ? buckets.map(bucketRow)
      : [
          html`<tr>
            <td colspan="6">No data yet.</td>
          </tr>`,
        ];

  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>cf-spam-gate stats</title>
        <style>
          :root {
            color-scheme: light dark;
          }
          body {
            font: 14px/1.4 system-ui, sans-serif;
            margin: 2rem;
          }
          h1 {
            font-size: 1.1rem;
          }
          nav {
            margin-bottom: 1rem;
          }
          nav a {
            margin-right: 1rem;
          }
          table {
            border-collapse: collapse;
            width: 100%;
            max-width: 60rem;
          }
          th,
          td {
            text-align: left;
            padding: 0.3rem 0.6rem;
            border-bottom: 1px solid #8884;
          }
          th {
            font-weight: 600;
          }
          td:nth-child(2),
          td:nth-child(3),
          td:nth-child(4),
          td:nth-child(5) {
            text-align: right;
          }
          th:nth-child(2),
          th:nth-child(3),
          th:nth-child(4),
          th:nth-child(5) {
            text-align: right;
          }
        </style>
      </head>
      <body>
        <h1>cf-spam-gate stats — ${granularity}ly</h1>
        <nav>
          <a href="?granularity=${otherGranularity}"
            >view ${otherGranularity}ly</a
          >
          <a href="/stats.json?granularity=${granularity}">raw JSON</a>
        </nav>
        <table>
          <thead>
            <tr>
              <th>Bucket</th>
              <th>Total</th>
              <th>Spam</th>
              <th>Forwarded</th>
              <th>Failed</th>
              <th>Signals fired</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </body>
    </html> `;
}
