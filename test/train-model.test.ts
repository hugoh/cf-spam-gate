import { describe, expect, it } from "vitest";
import {
  buildMeta,
  computeCorpusHash,
  countLabels,
  parseCorpus,
  pruneVocabulary,
  stripCorpusArtifacts,
} from "../scripts/train-model.mjs";

const HEADER = "Message ID,Subject,Message,Spam/Ham,Date";

describe("parseCorpus", () => {
  it("parses CSV rows into [label, subject+message] pairs", () => {
    const csv = `${HEADER}\n0,hello there,how are you,ham,1999-12-10\n1,win now,click here,spam,1999-12-11`;
    expect(parseCorpus(csv)).toEqual([
      ["ham", "hello there\nhow are you"],
      ["spam", "win now\nclick here"],
    ]);
  });

  it("handles quoted fields containing commas and embedded newlines", () => {
    const csv = `${HEADER}\n0,"vastar, resources","line one\nline two",ham,1999-12-10`;
    expect(parseCorpus(csv)).toEqual([
      ["ham", "vastar, resources\nline one\nline two"],
    ]);
  });

  it("drops rows with a label other than spam/ham", () => {
    const csv = `${HEADER}\n0,hi,hello,ham,1999-12-10\n1,x,something,unknown,1999-12-10\n2,win,now,spam,1999-12-10`;
    expect(parseCorpus(csv)).toEqual([
      ["ham", "hi\nhello"],
      ["spam", "win\nnow"],
    ]);
  });

  it("drops rows with no usable text (empty subject and message)", () => {
    const csv = `${HEADER}\n0,hi,hello,ham,1999-12-10\n1,,,ham,1999-12-10`;
    expect(parseCorpus(csv)).toEqual([["ham", "hi\nhello"]]);
  });

  it("keeps a row when only the subject is present (empty message)", () => {
    const csv = `${HEADER}\n0,christmas tree farm pictures,,ham,1999-12-10`;
    expect(parseCorpus(csv)).toEqual([["ham", "christmas tree farm pictures"]]);
  });
});

describe("stripCorpusArtifacts", () => {
  it("removes the company name and compounds of it", () => {
    // non-word fragments (the "." in "enron.com", the "'" in "enron's") are
    // left behind — harmless, they're not company-identifying tokens on their own
    expect(
      stripCorpusArtifacts("enron enron.com enronxgate enron's stock")
        .trim()
        .split(/\s+/),
    ).toEqual([".com", "'s", "stock"]);
  });

  it("removes the internal routing/facility codes as whole words only", () => {
    expect(
      stripCorpusArtifacts("cc: ect hou team").trim().split(/\s+/),
    ).toEqual(["cc:", "team"]);
  });

  it("doesn't touch unrelated words that merely contain those substrings", () => {
    expect(stripCorpusArtifacts("respect houston hour")).toBe(
      "respect houston hour",
    );
  });

  it("leaves ordinary text untouched", () => {
    expect(stripCorpusArtifacts("free prize click now")).toBe(
      "free prize click now",
    );
  });
});

describe("pruneVocabulary", () => {
  function fakeClassifier(
    wordFrequencyCount: Record<string, Record<string, number>>,
  ) {
    return {
      wordFrequencyCount,
      vocabulary: Object.values(wordFrequencyCount).flatMap((table) =>
        Object.keys(table),
      ),
      wordCount: {},
    };
  }

  it("does nothing when vocabulary is already at or under the limit", () => {
    const classifier = fakeClassifier({ ham: { a: 5, b: 3 } });
    const before = JSON.stringify(classifier.wordFrequencyCount);

    pruneVocabulary(classifier, 5);

    expect(JSON.stringify(classifier.wordFrequencyCount)).toBe(before);
  });

  it("keeps only the top-N most frequent words per category", () => {
    const classifier = fakeClassifier({
      ham: { common: 100, rare: 1, mid: 10 },
      spam: { win: 50, free: 40, prize: 1 },
    });

    pruneVocabulary(classifier, 2);

    expect(classifier.wordFrequencyCount).toEqual({
      ham: { common: 100, mid: 10 },
      spam: { win: 50, free: 40 },
    });
  });

  it("recomputes vocabulary and wordCount to match the pruned state", () => {
    const classifier = fakeClassifier({
      ham: { common: 100, rare: 1, mid: 10 },
    });

    pruneVocabulary(classifier, 2);

    expect(classifier.vocabulary.sort()).toEqual(["common", "mid"]);
    expect(classifier.wordCount).toEqual({ ham: 2 });
  });

  it("does nothing when limit is falsy (unbounded)", () => {
    const classifier = fakeClassifier({ ham: { a: 1, b: 2 } });
    const before = JSON.stringify(classifier.wordFrequencyCount);

    pruneVocabulary(classifier, 0);

    expect(JSON.stringify(classifier.wordFrequencyCount)).toBe(before);
  });
});

describe("countLabels", () => {
  it("counts spam and ham rows", () => {
    const rows = [
      ["ham", "a"],
      ["spam", "b"],
      ["ham", "c"],
    ];
    expect(countLabels(rows)).toEqual({ spam: 1, ham: 2 });
  });
});

describe("computeCorpusHash", () => {
  it("is deterministic for the same content", () => {
    expect(computeCorpusHash("hello")).toBe(computeCorpusHash("hello"));
  });

  it("differs for different content", () => {
    expect(computeCorpusHash("hello")).not.toBe(computeCorpusHash("world"));
  });

  it("accepts binary data (the corpus is fetched as a zip archive)", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(computeCorpusHash(bytes)).toBe(
      computeCorpusHash(new Uint8Array([1, 2, 3])),
    );
  });
});

describe("buildMeta", () => {
  it("assembles trainedAt/corpusUrl/hash/counts/vocabularyLimit into one metadata object", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const csv = `${HEADER}\n0,hi,hello,ham,1999-12-10\n1,win,now,spam,1999-12-10`;
    const rows = parseCorpus(csv);
    const counts = countLabels(rows);
    const bytes = new Uint8Array([1, 2, 3]);

    expect(
      buildMeta({
        corpusUrl: "https://example.com/corpus.zip",
        bytes,
        rows,
        counts,
        vocabularyLimit: 8000,
        now,
      }),
    ).toEqual({
      trainedAt: "2026-01-01T00:00:00.000Z",
      corpusUrl: "https://example.com/corpus.zip",
      corpusSha256: computeCorpusHash(bytes),
      vocabularyLimit: 8000,
      messageCount: 2,
      spamCount: 1,
      hamCount: 1,
    });
  });
});
