import type { CharSpan, Chunk, Chunker, Embedder, ParsedDocument } from "../../core/index.js";
import { RagError, noopLogger } from "../../shared/index.js";
import type { Logger } from "../../shared/index.js";
import type { SentenceSplitter } from "./basic-sentence-splitter.js";
import { findBreakpoints, neighbourSimilarities } from "./semantic-breakpoints.js";
import type { BreakRule } from "./semantic-breakpoints.js";

/** Builds a complete chunk from a span and its text. `createChunk` of RAG-020 has this shape. */
export type ChunkFactory = (
  doc: ParsedDocument,
  strategy: string,
  span: CharSpan,
  text: string,
) => Chunk;

export interface SemanticChunkerOptions {
  /** Embeds the sentences. The only thing this chunker needs from the outside world. */
  readonly embedder: Embedder;
  readonly splitSentences: SentenceSplitter;
  readonly createChunk: ChunkFactory;
  /** What counts as a topic shift. */
  readonly breakRule: BreakRule;
  /** A chunk is never made longer than this, whatever the similarity says (a single longer sentence stays whole). */
  readonly maxTokens: number;
  /** A topic shift is ignored until the chunk has at least this many tokens. Default 0. */
  readonly minTokens?: number;
  /** Default: one token per four characters, until the tokenizer of RAG-021 exists. */
  readonly countTokens?: (text: string) => number;
  readonly logger?: Logger;
}

const approximateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Cuts the document where the topic shifts: embeds every sentence, measures how similar each one is
 * to the next, and breaks where the similarity is low. Chunks are runs of whole, consecutive
 * sentences, so they follow the document in order and leave no gaps.
 */
export class SemanticChunker implements Chunker {
  readonly name = "semantic";
  private readonly minTokens: number;
  private readonly countTokens: (text: string) => number;
  private readonly logger: Logger;

  constructor(private readonly options: SemanticChunkerOptions) {
    this.minTokens = options.minTokens ?? 0;
    this.countTokens = options.countTokens ?? approximateTokens;
    this.logger = (options.logger ?? noopLogger).child({ chunker: this.name });
  }

  async chunk(doc: ParsedDocument): Promise<readonly Chunk[]> {
    const sentences = this.options.splitSentences(doc.text);
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
    let forcedBreaks = 0;

    const close = (lastIndex: number): void => {
      const start = sentences[first]?.start;
      const end = sentences[lastIndex]?.end;
      if (start === undefined || end === undefined) return;
      chunks.push(
        this.options.createChunk(doc, this.name, { start, end }, doc.text.slice(start, end)),
      );
    };

    texts.forEach((text, index) => {
      const size = this.countTokens(text);
      if (index > first) {
        const topicShift = shifts[index - 1] === true && tokens >= this.minTokens;
        const tooLong = tokens + size > this.options.maxTokens;
        if (topicShift || tooLong) {
          if (!topicShift) forcedBreaks++;
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
      topicBreaks: chunks.length - 1 - forcedBreaks,
      sizeBreaks: forcedBreaks,
      chunks: chunks.length,
    });
    return chunks;
  }
}
