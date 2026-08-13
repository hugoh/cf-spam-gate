#!/usr/bin/env node
/**
 * Trains the naivebayes content classifier bundled with the worker.
 *
 * Runs offline (locally, or from the scheduled retrain workflow) — never at
 * request time. Fetches a public labeled ham/spam corpus, trains a fresh
 * classifier on it, and writes the serialized model to data/model.json,
 * which the worker imports directly as a JSON module.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import NaiveBayes from "@ladjs/naivebayes";

const CORPUS_URL =
  process.env.CORPUS_URL ??
  "https://raw.githubusercontent.com/justmarkham/pycon-2016-tutorial/master/data/sms.tsv";
const MODEL_PATH = fileURLToPath(
  new URL("../data/model.json", import.meta.url),
);

async function fetchCorpus(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `failed to fetch training corpus from ${url}: HTTP ${response.status}`,
    );
  }
  const body = await response.text();

  return body
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(
      ([label, text]) => (label === "spam" || label === "ham") && text?.trim(),
    );
}

async function main() {
  console.log(`fetching training corpus from ${CORPUS_URL}`);
  const rows = await fetchCorpus(CORPUS_URL);
  if (rows.length === 0) {
    throw new Error(
      "training corpus was empty after parsing — check CORPUS_URL / format",
    );
  }

  const counts = { spam: 0, ham: 0 };
  const classifier = new NaiveBayes();
  for (const [label, text] of rows) {
    classifier.learn(text, label);
    counts[label] += 1;
  }

  console.log(
    `trained on ${rows.length} messages (${counts.spam} spam, ${counts.ham} ham)`,
  );

  await writeFile(MODEL_PATH, classifier.toJson(2));
  console.log(`wrote model to ${MODEL_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
