declare module "@ladjs/naivebayes" {
  interface CategoryProbability {
    category: string;
    probability: number;
  }

  export default class NaiveBayes {
    constructor(options?: Record<string, unknown>);
    learn(text: string, category: string): void;
    categorize(
      text: string,
      asProbabilities?: boolean,
    ): string | CategoryProbability;
    probabilities(text: string): CategoryProbability[];
    toJson(prettyPrint?: number): string;
    toJsonObject(): Record<string, unknown>;
    static fromJson(json: string, limit?: number): NaiveBayes;
  }
}
