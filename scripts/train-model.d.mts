export function parseCorpus(csvText: string): string[][];
export function stripCorpusArtifacts(text: string): string;
export interface PruneableClassifier {
  vocabulary: string[];
  wordFrequencyCount: Record<string, Record<string, number>>;
  wordCount: Record<string, number>;
}
export function pruneVocabulary(
  classifier: PruneableClassifier,
  limit: number,
): void;
export function countLabels(rows: string[][]): { spam: number; ham: number };
export function computeCorpusHash(bytes: string | Uint8Array): string;
export function buildMeta(args: {
  corpusUrl: string;
  bytes: string | Uint8Array;
  rows: unknown[];
  counts: { spam: number; ham: number };
  vocabularyLimit: number;
  now?: Date;
}): {
  trainedAt: string;
  corpusUrl: string;
  corpusSha256: string;
  vocabularyLimit: number;
  messageCount: number;
  spamCount: number;
  hamCount: number;
};
