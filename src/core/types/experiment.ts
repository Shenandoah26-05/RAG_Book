// The records an experiment writes. They live in core because the store that saves them is an
// adapter, and adapters may only know core. Plain data: no behaviour.

/** Facts every result repeats, so a line of the results file can be read, and trusted, on its own. */
export interface ResultProvenance {
  readonly experiment: string;
  readonly variant: string;
  /** `hashConfig` of the configuration the variant ran with. */
  readonly configHash: string;
  /** The commit the code was at, or null outside a repository. */
  readonly gitCommit: string | null;
  /** `version` of the dataset's meta file. */
  readonly datasetVersion: string;
  /** The model behind each part: e.g. `ollama:all-minilm`, `ollama:llama3.2`. */
  readonly models: {
    readonly embedder: string;
    readonly generator: string;
    /** Present when answers were judged. */
    readonly judge?: string;
  };
}

/** One chunk of a result list, with whether it overlapped a gold passage. */
export interface RetrievedRecord {
  readonly chunkId: string;
  readonly rank: number;
  readonly score: number;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly relevant: boolean;
}

/** The five retrieval metrics for one question, at the variant's `k`. */
export interface RetrievalScores {
  readonly hit: number;
  readonly precision: number;
  readonly recall: number;
  readonly mrr: number;
  readonly ndcg: number;
}

/** The generation scores for one answer. */
export interface GenerationScores {
  /** Undefined when the answer made no claim (a refusal). */
  readonly faithfulness?: number;
  readonly relevance: number;
  readonly correctness: number;
  /** `"<id>@<version>"` of each judge prompt used. */
  readonly promptVersions: readonly string[];
}

/** One line of `results.jsonl`: what one variant did with one question. */
export interface QuestionResult extends ResultProvenance {
  readonly questionId: string;
  readonly kind: "factual" | "multi-part" | "unanswerable";
  /** The cutoff the metrics were taken at: the variant's `retrieval.k`. */
  readonly k: number;
  /** The chunks the variant found, best first. */
  readonly retrieved: readonly RetrievedRecord[];
  /** Absent for an unanswerable question, which has nothing to find. */
  readonly retrieval?: RetrievalScores;
  /** False when the system declined to answer (nothing found, or the score was too low). */
  readonly answered: boolean;
  readonly refusal?: string;
  /** Present only when the experiment generates answers. */
  readonly answer?: string;
  /** Present only when the answer was judged. */
  readonly generation?: GenerationScores;
  readonly latencyMs: {
    readonly retrieval: number;
    readonly generation?: number;
    readonly judge?: number;
  };
  readonly tokens?: { readonly prompt?: number; readonly output?: number };
  /** Set when this question failed. The other fields describe what was done before it did. */
  readonly error?: string;
}

/** How the questions of one variant came out. Means are over the questions that have the score. */
export interface VariantSummary {
  readonly variant: string;
  readonly configHash: string;
  /** The settings that make this variant differ from the base, as written in the experiment. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** The config file the variant ran with, so the run can be repeated. */
  readonly configFile: string;
  readonly k: number;
  readonly models: ResultProvenance["models"];
  /** `<chunker>__<embedder>`, and whether the index was built for this run or reused. */
  readonly index: { readonly namespace: string; readonly status: "built" | "reused" };
  readonly questions: {
    readonly total: number;
    readonly answerable: number;
    readonly unanswerable: number;
    readonly failed: number;
  };
  /** Means over answerable questions that did not fail. Absent if there were none. */
  readonly retrieval?: RetrievalScores & { readonly questions: number };
  /** Means over answered, judged questions. Absent when answers were not judged. */
  readonly generation?: {
    readonly judged: number;
    readonly faithfulness?: number;
    readonly relevance: number;
    readonly correctness: number;
  };
  /**
   * How often the system declined. `unanswerableRefused / unanswerable` should be high,
   * `answerableRefused / answerable` low.
   */
  readonly refusals: {
    readonly unanswerableRefused: number;
    readonly answerableRefused: number;
  };
  readonly latencyMs: {
    readonly retrievalP50: number;
    readonly retrievalP95: number;
    readonly generationP50?: number;
    readonly generationP95?: number;
  };
  readonly tokens: { readonly prompt: number; readonly output: number };
  /** Set when the variant could not run at all (a bad config, an index that would not build). */
  readonly error?: string;
}

/** `summary.json`: the experiment as a whole. */
export interface ExperimentSummary {
  readonly experiment: string;
  readonly description?: string;
  readonly dataset: string;
  readonly datasetVersion: string;
  readonly gitCommit: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Whether answers were generated and judged, or only retrieval was measured. */
  readonly generation: boolean;
  readonly variants: readonly VariantSummary[];
}
