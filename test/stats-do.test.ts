import { env as rawEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import type { StatsCounter } from "../src/stats-do";

const env = rawEnv as unknown as Required<Pick<Env, "STATS">>;

const RETENTION = { hour: 30, day: 400 };

const ZERO_SCORES = {
  content: 0,
  url: 0,
  header: 0,
  dnsbl: 0,
  attachment: 0,
  pii: 0,
};

function stub() {
  const id = env.STATS.idFromName(`test-${crypto.randomUUID()}`);
  return env.STATS.get(id);
}

describe("StatsCounter", () => {
  it("creates a bucket on the first event", async () => {
    const object = stub();
    await runInDurableObject(object, async (raw) => {
      const instance = raw as unknown as StatsCounter;
      instance.recordEvent(
        ZERO_SCORES,
        false,
        "2026-08-14T09:30:00.000Z",
        RETENTION,
      );

      expect(instance.getStats("hour", 10)).toEqual([
        { key: "2026-08-14T09", total: 1, spam: 0, forwarded: 1, signals: {} },
      ]);
      expect(instance.getStats("day", 10)).toEqual([
        { key: "2026-08-14", total: 1, spam: 0, forwarded: 1, signals: {} },
      ]);
    });
  });

  it("increments an existing bucket atomically across repeated calls", async () => {
    const object = stub();
    await runInDurableObject(object, async (raw) => {
      const instance = raw as unknown as StatsCounter;
      instance.recordEvent(
        ZERO_SCORES,
        true,
        "2026-08-14T09:05:00.000Z",
        RETENTION,
      );
      instance.recordEvent(
        ZERO_SCORES,
        false,
        "2026-08-14T09:55:00.000Z",
        RETENTION,
      );

      expect(instance.getStats("hour", 10)).toEqual([
        { key: "2026-08-14T09", total: 2, spam: 1, forwarded: 1, signals: {} },
      ]);
    });
  });

  it("buckets by hour and by day separately", async () => {
    const object = stub();
    await runInDurableObject(object, async (raw) => {
      const instance = raw as unknown as StatsCounter;
      instance.recordEvent(
        ZERO_SCORES,
        false,
        "2026-08-14T09:00:00.000Z",
        RETENTION,
      );
      instance.recordEvent(
        ZERO_SCORES,
        false,
        "2026-08-14T10:00:00.000Z",
        RETENTION,
      );

      const hourly = instance.getStats("hour", 10);
      expect(hourly.map((b) => b.key)).toEqual([
        "2026-08-14T10",
        "2026-08-14T09",
      ]);
      expect(instance.getStats("day", 10)).toEqual([
        { key: "2026-08-14", total: 2, spam: 0, forwarded: 2, signals: {} },
      ]);
    });
  });

  it("merges fired-signal counts into the bucket", async () => {
    const object = stub();
    await runInDurableObject(object, async (raw) => {
      const instance = raw as unknown as StatsCounter;
      instance.recordEvent(
        { ...ZERO_SCORES, content: 0.9, url: 0.4 },
        true,
        "2026-08-14T09:00:00.000Z",
        RETENTION,
      );
      instance.recordEvent(
        { ...ZERO_SCORES, content: 0.6, dnsbl: 1 },
        true,
        "2026-08-14T09:10:00.000Z",
        RETENTION,
      );

      expect(instance.getStats("hour", 10)[0].signals).toEqual({
        content: 2,
        dnsbl: 1,
      });
    });
  });

  it("prunes buckets older than the configured retention", async () => {
    const object = stub();
    await runInDurableObject(object, async (raw) => {
      const instance = raw as unknown as StatsCounter;
      instance.recordEvent(ZERO_SCORES, false, "2026-01-01T00:00:00.000Z", {
        hour: 1,
        day: 1,
      });
      instance.recordEvent(ZERO_SCORES, false, "2026-01-05T00:00:00.000Z", {
        hour: 1,
        day: 1,
      });

      expect(instance.getStats("hour", 10).map((b) => b.key)).toEqual([
        "2026-01-05T00",
      ]);
      expect(instance.getStats("day", 10).map((b) => b.key)).toEqual([
        "2026-01-05",
      ]);
    });
  });
});
