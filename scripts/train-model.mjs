#!/usr/bin/env node
/**
 * Trains the naivebayes content classifier bundled with the worker.
 *
 * Runs offline (locally, or on demand — see README "Retraining") — never at
 * request time. Fetches the Enron-Spam corpus (zipped CSV), trains a fresh
 * classifier on it, and writes the serialized model to data/model.json
 * (which the worker imports directly as a JSON module) plus a sibling
 * data/model.meta.json recording when it was trained and from what corpus,
 * so a given model.json's provenance doesn't depend on digging through git
 * history.
 *
 * Corpus: Enron-Spam (Metsis, Androutsopoulos & Paliouras), packaged as a
 * single CSV by https://github.com/MWiechmann/enron_spam_data (GPLv3 —
 * this repo is GPLv3 too, so training on it is license-compatible).
 *
 * See train-model.config.mjs for the corpus URL, vocabulary size, and
 * corpus-specific stopword list.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import NaiveBayes from "@ladjs/naivebayes";
import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";
import {
  CORPUS_STOPWORD_PATTERNS,
  CORPUS_URL,
  VOCABULARY_LIMIT,
} from "./train-model.config.mjs";

const MODEL_PATH = fileURLToPath(
  new URL("../data/model.json", import.meta.url),
);
const META_PATH = fileURLToPath(
  new URL("../data/model.meta.json", import.meta.url),
);

/** Parses the corpus CSV (columns: Message ID, Subject, Message, Spam/Ham, Date) into [label, text] rows. */
export function parseCorpus(csvText) {
  const records = parse(csvText, { columns: true, skip_empty_lines: true });

  return records
    .map((record) => {
      const label = record["Spam/Ham"]?.trim();
      const text = [record.Subject, record.Message]
        .filter(Boolean)
        .join("\n")
        .trim();
      return [label, text];
    })
    .filter(([label, text]) => (label === "spam" || label === "ham") && text);
}

export function stripCorpusArtifacts(text) {
  return CORPUS_STOPWORD_PATTERNS.reduce(
    (cleaned, pattern) => cleaned.replace(pattern, " "),
    text,
  );
}

/**
 * naivebayes's own vocabularyLimit re-sorts every category's full word list
 * by frequency on every single learn() call once the vocabulary exceeds the
 * limit — O(vocabulary size) per message, which dominates training time at
 * any non-trivial limit (30000 words go from ~90s to ~6min vs. 8000).
 * Training unbounded and pruning once at the end (this function, applying
 * the identical top-N-by-frequency-per-category logic the library uses)
 * gets the same final model for a fraction of the time.
 */
export function pruneVocabulary(classifier, limit) {
  if (!limit || classifier.vocabulary.length <= limit) return;

  const newFrequencyCount = {};
  for (const category of Object.keys(classifier.wordFrequencyCount)) {
    const frequencyTable = classifier.wordFrequencyCount[category];
    const words = Object.keys(frequencyTable);
    if (words.length <= limit) {
      newFrequencyCount[category] = frequencyTable;
      continue;
    }

    const frequentWords = words.sort(
      (a, b) => frequencyTable[b] - frequencyTable[a],
    );
    newFrequencyCount[category] = {};
    for (let count = 0; count < limit; count++) {
      const word = frequentWords[count];
      newFrequencyCount[category][word] = frequencyTable[word];
    }
  }

  classifier.wordFrequencyCount = newFrequencyCount;
  classifier.vocabulary = [];
  classifier.wordCount = {};
  for (const category of Object.keys(classifier.wordFrequencyCount)) {
    const words = Object.keys(classifier.wordFrequencyCount[category]);
    classifier.wordCount[category] = words.length;
    classifier.vocabulary = [...classifier.vocabulary, ...words];
  }
}

export function countLabels(rows) {
  const counts = { spam: 0, ham: 0 };
  for (const [label] of rows) counts[label] += 1;
  return counts;
}

export function computeCorpusHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildMeta({
  corpusUrl,
  bytes,
  rows,
  counts,
  vocabularyLimit,
  now = new Date(),
}) {
  return {
    trainedAt: now.toISOString(),
    corpusUrl,
    corpusSha256: computeCorpusHash(bytes),
    vocabularyLimit,
    messageCount: rows.length,
    spamCount: counts.spam,
    hamCount: counts.ham,
  };
}

async function fetchCorpus(url, cliProgress) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `failed to fetch training corpus from ${url}: HTTP ${response.status}`,
    );
  }

  const totalBytes = Number(response.headers.get("content-length") ?? 0);
  const downloadBar = new cliProgress.SingleBar(
    { format: "downloading |{bar}| {percentage}% | {value}/{total} bytes" },
    cliProgress.Presets.shades_classic,
  );
  downloadBar.start(totalBytes || 1, 0);

  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    received += chunk.length;
    downloadBar.update(totalBytes ? received : downloadBar.getTotal());
  }
  downloadBar.stop();

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  const unzipped = unzipSync(bytes);
  const csvEntry = Object.keys(unzipped).find((name) => name.endsWith(".csv"));
  if (!csvEntry) {
    throw new Error(`no .csv file found in corpus archive from ${url}`);
  }
  const csvText = new TextDecoder().decode(unzipped[csvEntry]);
  return { rows: parseCorpus(csvText), bytes };
}

async function main() {
  const { default: cliProgress } = await import("cli-progress");

  console.log(`fetching training corpus from ${CORPUS_URL}`);
  const { rows, bytes } = await fetchCorpus(CORPUS_URL, cliProgress);
  if (rows.length === 0) {
    throw new Error(
      "training corpus was empty after parsing — check CORPUS_URL / format",
    );
  }

  const counts = countLabels(rows);
  // Trained unbounded (no vocabularyLimit here) and pruned once afterward —
  // see pruneVocabulary's doc comment for why.
  const classifier = new NaiveBayes();
  const progressBar = new cliProgress.SingleBar(
    {
      format:
        "training |{bar}| {percentage}% | {value}/{total} messages | ETA: {eta}s",
    },
    cliProgress.Presets.shades_classic,
  );
  progressBar.start(rows.length, 0);
  for (const [label, text] of rows) {
    classifier.learn(stripCorpusArtifacts(text), label);
    progressBar.increment();
  }
  progressBar.stop();
  pruneVocabulary(classifier, VOCABULARY_LIMIT);

  console.log(
    `trained on ${rows.length} messages (${counts.spam} spam, ${counts.ham} ham), vocabularyLimit=${VOCABULARY_LIMIT}`,
  );

  await writeFile(MODEL_PATH, classifier.toJson(2));
  console.log(`wrote model to ${MODEL_PATH}`);

  const meta = buildMeta({
    corpusUrl: CORPUS_URL,
    bytes,
    rows,
    counts,
    vocabularyLimit: VOCABULARY_LIMIT,
  });
  await writeFile(META_PATH, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`wrote metadata to ${META_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
