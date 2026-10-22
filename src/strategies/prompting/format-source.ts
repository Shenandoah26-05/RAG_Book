import type { Chunk, Citation } from "../../core/index.js";

function pages(chunk: Chunk): string {
  const { pageStart, pageEnd } = chunk.metadata;
  return pageStart === pageEnd
    ? `p. ${pageStart.toString()}`
    : `pp. ${pageStart.toString()}-${pageEnd.toString()}`;
}

const SOURCES_TAG = /<(\/?)(sources)>/gi;

/**
 * A passage as the prompt shows it. The prompt fences the sources in `<sources>` tags, so a passage
 * that contained `</sources>` could end the fence early and have the text after it read as
 * instructions. Those two tags are written as `&lt;sources>` so they stay readable but cannot close
 * or open the fence. Nothing else changes, and the stored chunk and its citation are untouched.
 */
export function neutralizeFence(text: string): string {
  return text.replace(SOURCES_TAG, "&lt;$1$2>");
}

/**
 * One numbered source as the model reads it: a header with the section and the pages, then the
 * passage.
 *
 *   [2] Chapter 3 > 3.2 Embeddings (pp. 41-42)
 *   Embeddings map text to ...
 */
export function formatSource(index: number, chunk: Chunk): string {
  const where = neutralizeFence(chunk.metadata.sectionPath.join(" > "));
  const header = where === "" ? `(${pages(chunk)})` : `${where} (${pages(chunk)})`;
  return `[${index.toString()}] ${header}\n${neutralizeFence(chunk.text)}`;
}

/** The citation for source `[index]`: what a reader needs to open the book at the passage. */
export function makeCitation(index: number, chunk: Chunk): Citation {
  const { docId, pageStart, pageEnd, charStart, charEnd } = chunk.metadata;
  return {
    index,
    chunkId: chunk.id,
    docId,
    pageStart,
    pageEnd,
    charStart,
    charEnd,
    quote: chunk.text,
  };
}
