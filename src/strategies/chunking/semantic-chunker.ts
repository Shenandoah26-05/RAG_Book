import type { Chunk, Chunker, Embedder, ParsedDocument, Tokenizer } from "../../core/index.js";
import { RagError, noopLogger } from "../../shared/index.js";
import type { Logger } from "../../shared/index.js";
import { splitSentencesBasic } from "./basic-sentence-splitter.js";
import type { SentenceSplitter } from "./basic-sentence-splitter.js";
import { createChunk } from "./chunk-builder.js";
import { findBreakpoints, neighbourSimilarities } from "./semantic-breakpoints.js";
import type { BreakRule } from "./semantic-breakpoints.js";

export interface SemanticChunkerOptions {
  /** Embeds the sentences. The only thing this chunker needs from the outside world. */
  readonly embedder: Embedder;
  /** Sizes (`maxTokens`, `minTokens`) are counted with it, like every other chunker. */
  readonly tokenizer: Tokenizer;
  /** What counts as a topic shift. */
  readonly breakRule: BreakRule;
  /** A chunk is never made longer than this, whatever the similarity says (a single longer sentence stays whole). */
  readonly maxTokens: number;
  /** A topic shift is ignored until the chunk has at least this many tokens. Default 0. */
  readonly minTokens?: number;
  /** Default: the simple splitter. Pass the one from RAG-023 when it is available. */
  readonly splitSentences?: SentenceSplitter;
  readonly logger?: Logger;
}

/**
 * Cuts the document where the topic shifts: embeds every sentence, measures how similar each one is
 * to the next, and breaks where the similarity is low. Chunks are runs of whole, consecutive
 * sentences, so they follow the document in order and leave no gaps.
 *
 * It is the only chunker that depends on another port (`Embedder`), which is why it receives one
 * through its constructor.
 */
export class SemanticChunker implements Chunker {
  readonly name = "semantic";
  private readonly minTokens: number;
  private readonly splitSentences: SentenceSplitter;
  private readonly logger: Logger;

  constructor(private readonly options: SemanticChunkerOptions) {
    const minTokens = options.minTokens ?? 0;
    if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
      throw new RagError(
        "CONFIG_INVALID",
        "semantic: maxTokens must be a whole number of 1 or more",
      );
    }
    if (!Number.isInteger(minTokens) || minTokens < 0 || minTokens >= options.maxTokens) {
      throw new RagError(
        "CONFIG_INVALID",
        "semantic: minTokens must be at least 0 and below maxTokens",
      );
    }
    this.minTokens = minTokens;
    this.splitSentences = options.splitSentences ?? splitSentencesBasic;
    this.logger = (options.logger ?? noopLogger).child({ chunker: this.name });
  }

  async chunk(doc: ParsedDocument): Promise<readonly Chunk[]> {
    const sentences = this.splitSentences(doc.text);
    if (sentences.length === 0) return [];

    const texts = sentences.map((s) => doc.text.slice(s.start, s.end));
    const vectors = await this.options.embedder.embed(texts, "document");
    if (vectors.length !== texts.length) {
      throw new RagError(
        "INTERNAL",
        `Embedder ${this.options.embedder.modelId} returned ${vectors.length.toString()} vectors for ${texts.length.toString()} sentences`,
      );
    }

    const shifts = findBreakpoints(neighbourSimilarities(vectors), this.options.breakRule);
    const chunks: Chunk[] = [];
    let first = 0;
    let tokens = 0;
    let sizeBreaks = 0;

    const close = (lastIndex: number): void => {
      const start = sentences[first]?.start;
      const end = sentences[lastIndex]?.end;
      if (start === undefined || end === undefined) return;
      chunks.push(createChunk(doc, this.name, { start, end }));
    };

    texts.forEach((text, index) => {
      const size = this.options.tokenizer.count(text);
      if (index > first) {
        const topicShift = shifts[index - 1] === true && tokens >= this.minTokens;
        const tooLong = tokens + size > this.options.maxTokens;
        if (topicShift || tooLong) {
          if (!topicShift) sizeBreaks++;
          close(index - 1);
          first = index;
          tokens = 0;
        }
      }
      tokens += size;
    });
    close(sentences.length - 1);

    this.logger.info("semantic chunking done", {
      docId: doc.id,
      sentences: sentences.length,
      topicBreaks: chunks.length - 1 - sizeBreaks,
      sizeBreaks,
      chunks: chunks.length,
    });
    return chunks;
  }
}
