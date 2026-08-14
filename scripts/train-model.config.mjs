/**
 * Training configuration for scripts/train-model.mjs — kept separate from
 * the training logic so the corpus source, vocabulary size, and
 * corpus-specific stopwords can be reviewed/changed on their own whenever
 * the corpus changes, without touching the fetch/parse/train pipeline.
 */

export const CORPUS_URL =
  process.env.CORPUS_URL ??
  "https://raw.githubusercontent.com/MWiechmann/enron_spam_data/master/enron_spam_data.zip";

export const VOCABULARY_LIMIT = Number(process.env.VOCABULARY_LIMIT ?? 30000);

/**
 * Artifacts of the *current* corpus (Enron-Spam's ham class is Enron's own
 * internal corporate email) that would otherwise train the classifier to
 * associate this specific company/dataset with "ham" rather than anything
 * genuinely spam-related. Review and update this list whenever CORPUS_URL
 * changes — it's corpus-specific, even though the stripping mechanism
 * itself (see stripCorpusArtifacts in train-model.mjs) isn't.
 */
export const CORPUS_STOPWORD_PATTERNS = [
  /\benron\w*/gi, // company name and compounds: enron.com, enronxgate, enrononline, enron's, ...
  /\bect\b/gi, // internal email routing fragment (name@enron/hou/ect)
  /\bhou\b/gi, // internal facility code
];
