import { describe, expect, it } from "vitest";
import { lookupRoute } from "../src/routing";

function fakeKv(entries: Record<string, string>): KVNamespace {
  return {
    get: async (key: string) => entries[key] ?? null,
  } as unknown as KVNamespace;
}

describe("lookupRoute", () => {
  it("returns destinations and threshold for a configured recipient", async () => {
    const kv = fakeKv({
      "user@example.com": JSON.stringify({
        destinations: ["real@elsewhere.com"],
        threshold: 0.7,
      }),
    });

    const route = await lookupRoute(kv, "user@example.com");

    expect(route).toEqual({
      destinations: ["real@elsewhere.com"],
      threshold: 0.7,
    });
  });

  it("defaults threshold to undefined when not set, letting the caller apply the global default", async () => {
    const kv = fakeKv({
      "user@example.com": JSON.stringify({
        destinations: ["real@elsewhere.com"],
      }),
    });

    const route = await lookupRoute(kv, "user@example.com");

    expect(route).toEqual({
      destinations: ["real@elsewhere.com"],
      threshold: undefined,
    });
  });

  it("is case-insensitive on the recipient address", async () => {
    const kv = fakeKv({
      "user@example.com": JSON.stringify({
        destinations: ["real@elsewhere.com"],
      }),
    });

    const route = await lookupRoute(kv, "User@Example.com");

    expect(route?.destinations).toEqual(["real@elsewhere.com"]);
  });

  it("returns null when the recipient has no route configured", async () => {
    const kv = fakeKv({});

    const route = await lookupRoute(kv, "unknown@example.com");

    expect(route).toBeNull();
  });

  it("throws a descriptive error when the stored value is malformed JSON", async () => {
    const kv = fakeKv({ "user@example.com": "{not json" });

    await expect(lookupRoute(kv, "user@example.com")).rejects.toThrow(
      /malformed ROUTES entry/i,
    );
  });

  it("throws a descriptive error when destinations is missing or empty", async () => {
    const kv = fakeKv({
      "user@example.com": JSON.stringify({ destinations: [] }),
    });

    await expect(lookupRoute(kv, "user@example.com")).rejects.toThrow(
      /destinations/i,
    );
  });
});
