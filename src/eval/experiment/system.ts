import type { ResultProvenance, RetrievedChunk, VariantSummary } from "../../core/index.js";
import type { ExperimentVariant } from "./expand-variants.js";

/** What one variant did with one question, before it is scored. */
export interface SystemAnswer {
  /** The chunks the variant found, best first. Never more than the variant's `k`. */
  readonly retrieved: readonly RetrievedChunk[];
  /** The passages the model was given, in prompt order (what the judge checks claims against). */
  readonly sources: readonly string[];
  /** False when the system declined to answer. */
  readonly answered: boolean;
  readonly refusal?: string;
  /** Present when `generate` was asked for and the system answered. */
  readonly answer?: string;
  readonly tokens?: { readonly prompt?: number; readonly output?: number };
  readonly latencyMs: { readonly retrieval: number; readonly generation?: number };
}

/** A variant that is built and ready to be asked questions. */
export interface VariantSystem {
  readonly configHash: string;
  /** The config file it runs with, saved so the run can be repeated. */
  readonly configFile: string;
  /** The cutoff for the metrics: how many chunks the variant retrieves. */
  readonly k: number;
  readonly models: ResultProvenance["models"];
  readonly index: VariantSummary["index"];
  /**
   * @param generate whether to run the model on the sources. Without it only retrieval happens, and
   * no model is asked for an answer.
   */
  ask(
    question: string,
    options: { readonly generate: boolean; readonly signal?: AbortSignal },
  ): Promise<SystemAnswer>;
}

/**
 * Builds a variant: validates its configuration, builds or reuses its index, and wires its pipeline.
 * The runner knows nothing about how. It is given a variant and gets back something to ask.
 * @throws whatever stops the variant from running; the runner records it and goes on to the next
 */
export interface VariantFactory {
  prepare(variant: ExperimentVariant, signal?: AbortSignal): Promise<VariantSystem>;
}
