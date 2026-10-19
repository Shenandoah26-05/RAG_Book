import { buildPipelineWithConfig } from "./build-pipeline.js";
import type { BuildPipelineOptions } from "./build-pipeline.js";
import { ChatSession } from "./chat-session.js";

export interface BuildChatOptions extends BuildPipelineOptions {
  /** How many chunks to use for each question. Default: `retrieval.k`. */
  readonly k?: number;
  /** Start with `/debug` on. */
  readonly debug?: boolean;
}

/**
 * Builds the pipeline from the configuration (or the variant) and puts a chat session on top of it.
 * Nothing is sent over the network until the first question is asked.
 *
 * @throws as `buildPipeline` does: ConfigError for a bad config, CONFIG_INVALID for an unknown name,
 *   INVALID_ARGUMENT if there is no index yet (run `pnpm index`), INDEX_CORRUPT for a damaged one
 */
export async function buildChat(options: BuildChatOptions = {}): Promise<ChatSession> {
  const { k, debug, ...pipelineOptions } = options;
  const { pipeline, config, namespace } = await buildPipelineWithConfig(pipelineOptions);
  return new ChatSession({
    pipeline,
    config,
    namespace,
    variant: options.variant,
    k,
    ...(debug === undefined ? {} : { debug }),
  });
}
