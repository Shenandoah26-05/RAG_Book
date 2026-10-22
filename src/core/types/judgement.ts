/** What the judge is shown about one answered question. */
export interface JudgeInput {
  readonly question: string;
  /** The answer the system wrote. */
  readonly answer: string;
  /** The passages the model was given, in prompt order (`sources[i]` is source `[i + 1]`). */
  readonly sources: readonly string[];
  /** The reference answer from the dataset. For an unanswerable question, what a good system says. */
  readonly reference: string;
}

/** One statement made by the answer, and whether the sources back it up. */
export interface ClaimVerdict {
  readonly claim: string;
  readonly supported: boolean;
}

/** Whether the answer says only what the sources say. */
export interface FaithfulnessJudgement {
  /** Supported claims over all claims, 0 to 1. Undefined when the answer makes no claim (a refusal). */
  readonly score: number | undefined;
  readonly claims: readonly ClaimVerdict[];
}

/** One 0 to 1 score with the reason the judge gave for it. */
export interface ScoredJudgement {
  /** 1, 0.5 or 0: the judge picks a verdict from three, not a number from a scale. */
  readonly score: number;
  readonly reason: string;
}

/** The three generation scores for one answer, with what produced them. */
export interface AnswerJudgement {
  readonly faithfulness: FaithfulnessJudgement;
  /** Does the answer address the question, whether or not it is right? */
  readonly relevance: ScoredJudgement;
  /** Does the answer say what the reference says? */
  readonly correctness: ScoredJudgement;
  /** The judge model, e.g. "ollama:llama3.1". Differs from the generator's id on purpose. */
  readonly judgeModel: string;
  /** `"<id>@<version>"` of each prompt used, so a result names the wording that scored it. */
  readonly promptVersions: readonly string[];
}
