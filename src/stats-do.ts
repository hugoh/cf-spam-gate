import { DurableObject } from "cloudflare:workers";
import { SCORE_KEYS, type Scores } from "./signals";

export type Granularity = "hour" | "day";

export interface RetentionDays {
  hour: number;
  day: number;
}

export type EventOutcome = "spam" | "forwarded" | "failed";

export interface StatsBucket {
  key: string;
  total: number;
  spam: number;
  forwarded: number;
  failed: number;
  signals: Partial<Record<keyof Scores, number>>;
}

/** Signal scores at or above this are counted as "fired" in a bucket's per-signal breakdown. */
const SIGNAL_FIRE_THRESHOLD = 0.5;

function bucketKey(granularity: Granularity, nowIso: string): string {
  // nowIso is an ISO-8601 UTC timestamp, e.g. "2026-08-14T09:30:00.000Z".
  return granularity === "hour" ? nowIso.slice(0, 13) : nowIso.slice(0, 10);
}

/** Cutoff key: buckets with a key below this are stale and get pruned. */
function cutoffKey(
  granularity: Granularity,
  nowIso: string,
  retentionDays: number,
): string {
  const cutoff = new Date(
    new Date(nowIso).getTime() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  return bucketKey(granularity, cutoff);
}

interface BucketRow {
  [column: string]: string | number;
  key: string;
  total: number;
  spam: number;
  forwarded: number;
  failed: number;
  signals: string;
}

export class StatsCounter extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS buckets (
         granularity TEXT NOT NULL,
         key TEXT NOT NULL,
         total INTEGER NOT NULL DEFAULT 0,
         spam INTEGER NOT NULL DEFAULT 0,
         forwarded INTEGER NOT NULL DEFAULT 0,
         failed INTEGER NOT NULL DEFAULT 0,
         signals TEXT NOT NULL DEFAULT '{}',
         PRIMARY KEY (granularity, key)
       )`,
    );
    try {
      this.ctx.storage.sql.exec(
        "ALTER TABLE buckets ADD COLUMN failed INTEGER NOT NULL DEFAULT 0",
      );
    } catch {
      // Column already exists — fine on every startup after the first migration.
    }
  }

  recordEvent(scores: Scores, outcome: EventOutcome, nowIso: string): void {
    const firedSignals = SCORE_KEYS.filter(
      (key) => scores[key] >= SIGNAL_FIRE_THRESHOLD,
    );

    for (const granularity of ["hour", "day"] as const) {
      const key = bucketKey(granularity, nowIso);
      const existing = this.ctx.storage.sql
        .exec<BucketRow>(
          "SELECT * FROM buckets WHERE granularity = ? AND key = ?",
          granularity,
          key,
        )
        .toArray()[0];

      const signals: Partial<Record<keyof Scores, number>> = existing
        ? JSON.parse(existing.signals)
        : {};
      for (const signal of firedSignals) {
        signals[signal] = (signals[signal] ?? 0) + 1;
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO buckets (granularity, key, total, spam, forwarded, failed, signals)
         VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT (granularity, key) DO UPDATE SET
           total = total + 1,
           spam = spam + excluded.spam,
           forwarded = forwarded + excluded.forwarded,
           failed = failed + excluded.failed,
           signals = excluded.signals`,
        granularity,
        key,
        outcome === "spam" ? 1 : 0,
        outcome === "forwarded" ? 1 : 0,
        outcome === "failed" ? 1 : 0,
        JSON.stringify(signals),
      );
    }
  }

  purgeExpired(nowIso: string, retentionDays: RetentionDays): void {
    for (const granularity of ["hour", "day"] as const) {
      this.ctx.storage.sql.exec(
        "DELETE FROM buckets WHERE granularity = ? AND key < ?",
        granularity,
        cutoffKey(granularity, nowIso, retentionDays[granularity]),
      );
    }
  }

  getStats(granularity: Granularity, limit: number): StatsBucket[] {
    return this.ctx.storage.sql
      .exec<BucketRow>(
        "SELECT * FROM buckets WHERE granularity = ? ORDER BY key DESC LIMIT ?",
        granularity,
        limit,
      )
      .toArray()
      .map((row) => ({
        key: row.key,
        total: row.total,
        spam: row.spam,
        forwarded: row.forwarded,
        failed: row.failed,
        signals: JSON.parse(row.signals),
      }));
  }
}
