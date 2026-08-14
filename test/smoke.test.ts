import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

function fakeKv(entries: Record<string, string>): KVNamespace {
  return {
    get: async (key: string) => entries[key] ?? null,
  } as unknown as KVNamespace;
}

function fakeMessage(raw: string, to: string, from: string) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(raw);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  return {
    to,
    from,
    raw: stream,
    rawSize: bytes.length,
    headers: new Headers(),
    setReject: vi.fn(),
    forward: vi.fn(async () => ({}) as EmailSendResult),
    reply: vi.fn(async () => ({}) as EmailSendResult),
  } as unknown as ForwardableEmailMessage & {
    setReject: ReturnType<typeof vi.fn>;
    forward: ReturnType<typeof vi.fn>;
  };
}

const env: Env = {
  ROUTES: fakeKv({
    "you@example.com": JSON.stringify({
      destinations: ["real@elsewhere.example"],
    }),
  }),
  DEFAULT_THRESHOLD: "0.5",
  SIGNAL_WEIGHTS: JSON.stringify({
    content: 0.3,
    url: 0.15,
    header: 0.05,
    dnsbl: 0.1,
    attachment: 0.1,
    pii: 0.05,
    auth: 0.25,
  }),
  REJECT_MESSAGE: "Message rejected as spam",
};

describe("smoke test", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ Status: 0, Answer: [] }), {
            status: 200,
          }),
      ),
    );
  });

  it("forwards an ordinary, well-formed message", async () => {
    const raw = [
      "Received: from mail.elsewhere.example [203.0.113.7] by mx.example.com",
      "From: A Friend <friend@elsewhere.example>",
      "To: you@example.com",
      "Subject: Lunch tomorrow?",
      `Date: ${new Date().toUTCString()}`,
      "",
      "Hey, are you free for lunch tomorrow around noon?",
      "",
    ].join("\r\n");

    const message = fakeMessage(
      raw,
      "you@example.com",
      "friend@elsewhere.example",
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.email(message, env);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(message.forward).toHaveBeenCalledWith("real@elsewhere.example");

    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ to: "you@example.com", verdict: "forward" });
    logSpy.mockRestore();
  });

  it("rejects an obviously spammy message", async () => {
    const raw = [
      "Received: from bulk-mailer.spam-host.zip [198.51.100.66] by mx.example.com",
      "From: Prize Dept <winner@bulk-mailer.spam-host.zip>",
      "To: you@example.com",
      "Reply-To: claim@totally-different-domain.example",
      "Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom=winner@bulk-mailer.spam-host.zip; dkim=none",
      "Subject: URGENT CLAIM YOUR FREE PRIZE NOW",
      "",
      "CONGRATULATIONS you have WON a FREE PRIZE! Click now to claim: http://192.0.2.99/claim",
      "Act now before this offer expires! Free money! Buy now! Limited time!",
      "",
    ].join("\r\n");

    const message = fakeMessage(
      raw,
      "you@example.com",
      "winner@bulk-mailer.spam-host.zip",
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.email(message, env);

    expect(message.setReject).toHaveBeenCalled();
    expect(message.forward).not.toHaveBeenCalled();

    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({ to: "you@example.com", verdict: "reject" });
    logSpy.mockRestore();
  });

  it("uses the REJECT_MESSAGES category override for the dominant signal", async () => {
    const raw = [
      "Received: from bulk-mailer.spam-host.zip [198.51.100.66] by mx.example.com",
      "From: Prize Dept <winner@bulk-mailer.spam-host.zip>",
      "To: you@example.com",
      "Reply-To: claim@totally-different-domain.example",
      "Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom=winner@bulk-mailer.spam-host.zip; dkim=none",
      "Subject: URGENT CLAIM YOUR FREE PRIZE NOW",
      "",
      "CONGRATULATIONS you have WON a FREE PRIZE! Click now to claim: http://192.0.2.99/claim",
      "Act now before this offer expires! Free money! Buy now! Limited time!",
      "",
    ].join("\r\n");

    const message = fakeMessage(
      raw,
      "you@example.com",
      "winner@bulk-mailer.spam-host.zip",
    );
    const envWithRejectMessages: Env = {
      ...env,
      REJECT_MESSAGES: JSON.stringify({
        content: "Message rejected: looks like bulk/spam content",
      }),
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.email(message, envWithRejectMessages);

    expect(message.setReject).toHaveBeenCalledWith(
      "Message rejected: looks like bulk/spam content",
    );
  });

  it("rejects (rather than retrying) when the destination bounces the forward", async () => {
    const raw = [
      "Received: from mail.elsewhere.example [203.0.113.7] by mx.example.com",
      "From: A Friend <friend@elsewhere.example>",
      "To: you@example.com",
      "Subject: Lunch tomorrow?",
      `Date: ${new Date().toUTCString()}`,
      "",
      "Hey, are you free for lunch tomorrow around noon?",
      "",
    ].join("\r\n");

    const message = fakeMessage(
      raw,
      "you@example.com",
      "friend@elsewhere.example",
    );
    message.forward = vi.fn(async () => {
      throw new Error("destination rejected: 550 mailbox unavailable");
    });
    const recordEvent = vi.fn();
    const envWithStats: Env = {
      ...env,
      STATS_ENABLED: "true",
      STATS: {
        idFromName: vi.fn(() => "id"),
        get: vi.fn(() => ({ recordEvent })),
      } as unknown as Env["STATS"],
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await worker.email(message, envWithStats);

    expect(message.forward).toHaveBeenCalledWith("real@elsewhere.example");
    expect(message.setReject).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.any(Number) }),
      "failed",
      expect.any(String),
      { hour: 30, day: 400 },
    );

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("rejects mail to a recipient with no ROUTES entry", async () => {
    const raw = [
      "From: friend@elsewhere.example",
      "To: nobody@example.com",
      "Subject: hi",
      "",
      "hi",
      "",
    ].join("\r\n");

    const message = fakeMessage(
      raw,
      "nobody@example.com",
      "friend@elsewhere.example",
    );
    await worker.email(message, env);

    expect(message.setReject).toHaveBeenCalledWith("Recipient not configured");
    expect(message.forward).not.toHaveBeenCalled();
  });

  it("does not touch STATS when STATS_ENABLED is unset, and /stats 404s", async () => {
    const statsGet = vi.fn();
    const envWithoutStats: Env = {
      ...env,
      STATS: { get: statsGet } as unknown as Env["STATS"],
    };

    const raw = [
      "Received: from mail.elsewhere.example [203.0.113.7] by mx.example.com",
      "From: A Friend <friend@elsewhere.example>",
      "To: you@example.com",
      "Subject: Lunch tomorrow?",
      `Date: ${new Date().toUTCString()}`,
      "",
      "Hey, are you free for lunch tomorrow around noon?",
      "",
    ].join("\r\n");

    const message = fakeMessage(
      raw,
      "you@example.com",
      "friend@elsewhere.example",
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.email(message, envWithoutStats);

    expect(statsGet).not.toHaveBeenCalled();

    const response = await worker.fetch(
      new Request("https://worker.example/stats"),
      envWithoutStats,
    );
    expect(response.status).toBe(404);

    for (const path of ["/stats.json", "/stats.html"]) {
      const res = await worker.fetch(
        new Request(`https://worker.example${path}`),
        envWithoutStats,
      );
      expect(res.status).toBe(404);
    }
  });

  it("records stats and serves them at /stats(.html|.json) when STATS_ENABLED is true", async () => {
    const recordEvent = vi.fn();
    const getStats = vi.fn(async () => [
      {
        key: "2026-08-14T09",
        total: 1,
        spam: 0,
        forwarded: 1,
        failed: 0,
        signals: {},
      },
    ]);
    const stub = { recordEvent, getStats };
    const envWithStats: Env = {
      ...env,
      STATS_ENABLED: "true",
      STATS: {
        idFromName: vi.fn(() => "id"),
        get: vi.fn(() => stub),
      } as unknown as Env["STATS"],
    };

    const raw = [
      "Received: from mail.elsewhere.example [203.0.113.7] by mx.example.com",
      "From: A Friend <friend@elsewhere.example>",
      "To: you@example.com",
      "Subject: Lunch tomorrow?",
      `Date: ${new Date().toUTCString()}`,
      "",
      "Hey, are you free for lunch tomorrow around noon?",
      "",
    ].join("\r\n");

    const message = fakeMessage(
      raw,
      "you@example.com",
      "friend@elsewhere.example",
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.email(message, envWithStats);

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.any(Number) }),
      "forwarded",
      expect.any(String),
      { hour: 30, day: 400 },
    );

    const expectedJson = {
      granularity: "hour",
      buckets: [
        {
          key: "2026-08-14T09",
          total: 1,
          spam: 0,
          forwarded: 1,
          failed: 0,
          signals: {},
        },
      ],
    };

    const jsonResponse = await worker.fetch(
      new Request("https://worker.example/stats.json?granularity=hour"),
      envWithStats,
    );
    expect(jsonResponse.status).toBe(200);
    expect(await jsonResponse.json()).toEqual(expectedJson);

    for (const path of ["/stats", "/stats.html"]) {
      const htmlResponse = await worker.fetch(
        new Request(`https://worker.example${path}?granularity=hour`),
        envWithStats,
      );
      expect(htmlResponse.status).toBe(200);
      expect(htmlResponse.headers.get("content-type")).toMatch(/text\/html/);
      const html = await htmlResponse.text();
      expect(html).toContain("2026-08-14T09");
    }
  });
});
