import { describe, expect, it, vi } from "vitest";
import {
  logVerdict,
  parseJsonEnvVar,
  parseRejectMessages,
  parseSet,
  parseWeights,
} from "../src/index";
import { DEFAULT_SIGNAL_WEIGHTS } from "../src/signals";

describe("parseJsonEnvVar", () => {
  const isString = (value: unknown): value is string =>
    typeof value === "string";

  it("returns the fallback when the env var is undefined", () => {
    expect(parseJsonEnvVar(undefined, isString, "fallback")).toBe("fallback");
  });

  it("returns the fallback when the env var is an empty string", () => {
    expect(parseJsonEnvVar("", isString, "fallback")).toBe("fallback");
  });

  it("returns the parsed value when it satisfies the validator", () => {
    expect(parseJsonEnvVar('"hello"', isString, "fallback")).toBe("hello");
  });

  it("returns the fallback when the JSON is malformed", () => {
    expect(parseJsonEnvVar("{not json", isString, "fallback")).toBe("fallback");
  });

  it("returns the fallback when the parsed value fails validation", () => {
    expect(parseJsonEnvVar("42", isString, "fallback")).toBe("fallback");
  });

  it("calls onInvalid with the raw json on malformed input", () => {
    const onInvalid = vi.fn();
    parseJsonEnvVar("{not json", isString, "fallback", onInvalid);
    expect(onInvalid).toHaveBeenCalledWith("{not json");
  });

  it("calls onInvalid with the raw json when validation fails", () => {
    const onInvalid = vi.fn();
    parseJsonEnvVar("42", isString, "fallback", onInvalid);
    expect(onInvalid).toHaveBeenCalledWith("42");
  });

  it("does not call onInvalid when the value parses and validates", () => {
    const onInvalid = vi.fn();
    parseJsonEnvVar('"hello"', isString, "fallback", onInvalid);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("does not call onInvalid when the env var is unset", () => {
    const onInvalid = vi.fn();
    parseJsonEnvVar(undefined, isString, "fallback", onInvalid);
    expect(onInvalid).not.toHaveBeenCalled();
  });
});

describe("parseSet", () => {
  const fallback = new Set(["default.example"]);

  it("returns the fallback when unset", () => {
    expect(parseSet(undefined, fallback)).toBe(fallback);
  });

  it("parses a JSON array into a Set", () => {
    expect(parseSet('["a.example", "b.example"]', fallback)).toEqual(
      new Set(["a.example", "b.example"]),
    );
  });

  it("returns the fallback for malformed JSON", () => {
    expect(parseSet("not json", fallback)).toBe(fallback);
  });

  it("returns the fallback when the JSON value isn't an array", () => {
    expect(parseSet('{"a": 1}', fallback)).toBe(fallback);
  });

  it("returns an empty Set for an empty JSON array", () => {
    expect(parseSet("[]", fallback)).toEqual(new Set());
  });
});

describe("parseWeights", () => {
  it("returns the parsed weights when valid", () => {
    const weights = {
      content: 0.1,
      url: 0.1,
      header: 0.1,
      dnsbl: 0.1,
      attachment: 0.1,
      pii: 0.1,
      auth: 0.4,
    };
    expect(parseWeights(JSON.stringify(weights))).toEqual(weights);
  });

  it("falls back to the defaults and logs on malformed JSON", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseWeights("not json")).toEqual(DEFAULT_SIGNAL_WEIGHTS);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid SIGNAL_WEIGHTS config"),
    );
    errorSpy.mockRestore();
  });

  it("falls back to the defaults and logs when the shape is invalid", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseWeights('{"content": 0.5}')).toEqual(DEFAULT_SIGNAL_WEIGHTS);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("parseRejectMessages", () => {
  it("returns an empty object when unset", () => {
    expect(parseRejectMessages(undefined)).toEqual({});
  });

  it("parses a valid category-to-message map", () => {
    const messages = { content: "Rejected: spammy content" };
    expect(parseRejectMessages(JSON.stringify(messages))).toEqual(messages);
  });

  it("falls back to an empty object and logs on malformed JSON", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseRejectMessages("not json")).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid REJECT_MESSAGES config"),
    );
    errorSpy.mockRestore();
  });

  it("falls back to an empty object when values aren't all strings", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseRejectMessages('{"content": 42}')).toEqual({});
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("falls back to an empty object when the JSON value is an array", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseRejectMessages('["content"]')).toEqual({});
    errorSpy.mockRestore();
  });
});

describe("logVerdict", () => {
  const fields = {
    to: "you@example.com",
    from: "friend@elsewhere.example",
    subject: "Hello",
    senderIp: "203.0.113.7",
    dnsblResult: "clean" as const,
    scores: DEFAULT_SIGNAL_WEIGHTS,
    score: 0.1,
    threshold: 0.5,
  };

  it("logs a single JSON line combining the fields and the verdict", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logVerdict("reject", fields);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
      ...fields,
      verdict: "reject",
    });
    logSpy.mockRestore();
  });

  it("reflects the forward verdict", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logVerdict("forward", fields);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
      verdict: "forward",
    });
    logSpy.mockRestore();
  });
});
