import type { CharSpan, Chunk, Chunker, ParsedDocument } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { createChunk } from "./chunk-builder.js";
import { RecursiveChunker } from "./recursive-chunker.js";
import type { TokenCounter } from "./recursive-split.js";
import { documentView } from "./section-segments.js";

export interface ParentChildOptions {
  /** Cuts the document into the large chunks the answer is built from. Must not overlap. */
  readonly parentSplitter: Chunker;
  /** Cuts one parent, handed over as a document of its own, into the small chunks that are searched. */
  readonly childSplitter: Chunker;
}

interface Family {
  readonly parents: readonly Chunk[];
  readonly children: readonly Chunk[];
}

/**
 * Search small, answer big. The document is cut into parents, and each parent is cut again into
 * children that never cross a parent edge, so every child has exactly one parent. `chunk()` returns
 * the children (each with a `parentId`), which are what gets embedded and searched; `parents()`
 * returns the parents, which are stored but not indexed and looked up by id when a child matches.
 *
 * How the cutting is done is up to the two injected chunkers; this class only knows how they nest.
 */
export class ParentChildChunker implements Chunker {
  readonly name = "parent-child";
  /**
   * Parents carry their own strategy name. Without it a parent that is no bigger than a child would
   * get the same id as that child, and the child's `parentId` would point at itself.
   */
  readonly parentStrategy = "parent-child-parent";
  readonly #parentSplitter: Chunker;
  readonly #childSplitter: Chunker;
  // `chunk()` and `parents()` need the same split; the document is never modified, so it is a safe key
  readonly #families = new WeakMap<ParsedDocument, Promise<Family>>();

  constructor(options: ParentChildOptions) {
    this.#parentSplitter = options.parentSplitter;
    this.#childSplitter = options.childSplitter;
  }

  async chunk(doc: ParsedDocument): Promise<readonly Chunk[]> {
    return (await this.#family(doc)).children;
  }

  async parents(doc: ParsedDocument): Promise<readonly Chunk[]> {
    return (await this.#family(doc)).parents;
  }

  #family(doc: ParsedDocument): Promise<Family> {
    let family = this.#families.get(doc);
    if (family === undefined) {
      family = this.#split(doc);
      this.#families.set(doc, family);
    }
    return family;
  }

  async #split(doc: ParsedDocument): Promise<Family> {
    const parents: Chunk[] = [];
    const children: Chunk[] = [];
    let previousEnd = 0;
    for (const raw of await this.#parentSplitter.chunk(doc)) {
      const { charStart, charEnd } = raw.metadata;
      if (charStart < previousEnd) {
        throw new RagError(
          "INTERNAL",
          `Chunker "${this.#parentSplitter.name}" made overlapping parents; a child could not tell which one it belongs to.`,
        );
      }
      previousEnd = charEnd;

      const parent = createChunk(
        doc,
        this.parentStrategy,
        { start: charStart, end: charEnd },
        raw.text,
      );
      parents.push(parent);
      children.push(...(await this.#children(doc, parent)));
    }
    return { parents, children };
  }

  /** Splits one parent with the child splitter and maps its chunks back onto the real document. */
  async #children(doc: ParsedDocument, parent: Chunk): Promise<Chunk[]> {
    const offset = parent.metadata.charStart;
    const length = parent.metadata.charEnd - offset;
    const span: CharSpan = { start: offset, end: parent.metadata.charEnd };
    const inner = await this.#childSplitter.chunk(documentView(doc, span));
    return inner.map((raw) => {
      const { charStart, charEnd } = raw.metadata;
      if (charStart < 0 || charEnd > length) {
        throw new RagError(
          "INTERNAL",
          `Chunker "${this.#childSplitter.name}" returned a span outside the parent it was given.`,
        );
      }
      const shifted = { start: charStart + offset, end: charEnd + offset };
      return { ...createChunk(doc, this.name, shifted, raw.text), parentId: parent.id };
    });
  }
}

export interface RecursiveParentChildOptions {
  /** How many tokens a text has; the composition root passes the tokenizer's `count`. */
  readonly count: TokenCounter;
  /** Most tokens a parent may hold. */
  readonly parentTokens: number;
  /** Most tokens a child may hold. Must be below `parentTokens`. */
  readonly childTokens: number;
  /** Tokens repeated between neighbouring children (never parents). Default 0. */
  readonly childOverlapTokens?: number;
}

/** The usual setup: both levels are cut by the recursive chunker (RAG-024), at different sizes. */
export function recursiveParentChild(options: RecursiveParentChildOptions): ParentChildChunker {
  const { count, parentTokens, childTokens, childOverlapTokens = 0 } = options;
  if (!Number.isInteger(childTokens) || childTokens < 1 || childTokens >= parentTokens) {
    throw new RagError(
      "CONFIG_INVALID",
      "parent-child: childTokens must be a whole number of at least 1 and below parentTokens.",
    );
  }
  return new ParentChildChunker({
    parentSplitter: new RecursiveChunker({ maxTokens: parentTokens, overlapTokens: 0, count }),
    childSplitter: new RecursiveChunker({
      maxTokens: childTokens,
      overlapTokens: childOverlapTokens,
      count,
    }),
  });
}
