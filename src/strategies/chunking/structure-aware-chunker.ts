import type { CharSpan, Chunk, Chunker, ParsedDocument, Tokenizer } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { createChunk } from "./chunk-builder.js";
import { documentView, sectionSegments } from "./section-segments.js";

export interface StructureAwareOptions {
  /** Splits a section that is too long. Normally the recursive chunker (RAG-024). */
  readonly inner: Chunker;
  readonly tokenizer: Tokenizer;
  /** A section longer than this is handed to `inner`. */
  readonly maxTokens: number;
  /**
   * Neighbouring pieces shorter than this are joined with the next one, as long as the result still
   * fits `maxTokens`, so a heading with two lines does not become a chunk of its own. Default: a
   * quarter of `maxTokens`. Use 0 for exactly one chunk per section.
   */
  readonly minTokens?: number;
}

interface Piece {
  readonly span: CharSpan;
  readonly tokens: number;
}

/** "Chapter 3 > 3.2 Embeddings", the separator used in the heading path the embedder sees. */
const PATH_SEPARATOR = " > ";

/**
 * One chunk per section, split further only when a section is too long. The splitting is done by
 * another chunker, so this one only knows about the section tree. The heading path is put in
 * front of the text the embedder sees (`embedText`); `text` stays the raw passage.
 */
export class StructureAwareChunker implements Chunker {
  readonly name = "structure-aware";
  private readonly inner: Chunker;
  private readonly tokenizer: Tokenizer;
  private readonly maxTokens: number;
  private readonly minTokens: number;

  constructor(options: StructureAwareOptions) {
    const minTokens = options.minTokens ?? Math.floor(options.maxTokens / 4);
    if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
      throw new RagError(
        "CONFIG_INVALID",
        "structure-aware: maxTokens must be a whole number of at least 1.",
      );
    }
    if (!Number.isInteger(minTokens) || minTokens < 0 || minTokens >= options.maxTokens) {
      throw new RagError(
        "CONFIG_INVALID",
        "structure-aware: minTokens must be at least 0 and below maxTokens.",
      );
    }
    this.inner = options.inner;
    this.tokenizer = options.tokenizer;
    this.maxTokens = options.maxTokens;
    this.minTokens = minTokens;
  }

  async chunk(doc: ParsedDocument): Promise<readonly Chunk[]> {
    const chunks: Chunk[] = [];
    for (const piece of this.joinSmall(doc, this.measure(doc))) {
      if (piece.tokens <= this.maxTokens) {
        chunks.push(this.withHeadingPath(createChunk(doc, this.name, piece.span)));
      } else {
        chunks.push(...(await this.split(doc, piece.span)));
      }
    }
    return chunks;
  }

  private measure(doc: ParsedDocument): Piece[] {
    return sectionSegments(doc).map((span) => ({
      span,
      tokens: this.tokenizer.count(doc.text.slice(span.start, span.end)),
    }));
  }

  /** Joins a piece that is too small with the next one, while the result still fits. */
  private joinSmall(doc: ParsedDocument, pieces: readonly Piece[]): Piece[] {
    const joined: Piece[] = [];
    let current: Piece | undefined;
    for (const piece of pieces) {
      if (current === undefined) {
        current = piece;
        continue;
      }
      const span = { start: current.span.start, end: piece.span.end };
      const tokens =
        current.tokens < this.minTokens
          ? this.tokenizer.count(doc.text.slice(span.start, span.end))
          : Infinity;
      if (tokens <= this.maxTokens) {
        current = { span, tokens };
      } else {
        joined.push(current);
        current = piece;
      }
    }
    if (current !== undefined) {
      joined.push(current);
    }
    return joined;
  }

  /** Lets the inner chunker split one long piece, then maps its chunks back onto the document. */
  private async split(doc: ParsedDocument, span: CharSpan): Promise<Chunk[]> {
    const length = span.end - span.start;
    const inner = await this.inner.chunk(documentView(doc, span));
    return inner.map((chunk) => {
      const { charStart, charEnd } = chunk.metadata;
      if (charStart < 0 || charEnd > length) {
        throw new RagError(
          "INTERNAL",
          `Chunker "${this.inner.name}" returned a span outside the section it was given.`,
        );
      }
      const shifted = { start: charStart + span.start, end: charEnd + span.start };
      return this.withHeadingPath(createChunk(doc, this.name, shifted, chunk.text));
    });
  }

  private withHeadingPath(chunk: Chunk): Chunk {
    const path = chunk.metadata.sectionPath;
    if (path.length === 0) {
      return chunk;
    }
    return { ...chunk, embedText: `${path.join(PATH_SEPARATOR)}\n\n${chunk.text}` };
  }
}
