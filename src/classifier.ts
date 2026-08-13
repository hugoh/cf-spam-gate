import NaiveBayes from "@ladjs/naivebayes";
import model from "../data/model.json";

let cached: NaiveBayes | undefined;

/** The bundled, pretrained content classifier. See scripts/train-model.mjs for how it's produced. */
export function getClassifier(): NaiveBayes {
  if (!cached) {
    cached = NaiveBayes.fromJson(JSON.stringify(model));
  }
  return cached;
}
