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
    content: 0.5,
    url: 0.25,
    header: 0.1,
    dnsbl: 0.15,
    attachment: 0.2,
    pii: 0.05,
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
});
