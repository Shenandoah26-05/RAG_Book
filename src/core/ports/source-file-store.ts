/** A byte range of a file, both ends inclusive (the HTTP `Range` convention). */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/** The original file a document was made from. */
export interface SourceFile {
  /** Size in bytes. */
  readonly size: number;
  /** e.g. "application/pdf". */
  readonly mediaType: string;
  /**
   * The bytes of the file, or of `range` when given. Reading stops early (a `break`) without leaking
   * the file handle. `range` must lie inside the file.
   */
  read(range?: ByteRange): AsyncIterable<Uint8Array>;
}

/**
 * Finds the source file of a processed document. A processed document keeps the text and its
 * structure, not the PDF; the reader needs the PDF itself to draw the pages.
 *
 * Rules every store follows:
 * 1. A file is found **by the SHA-256 of its contents**, the same hash a document is identified
 *    by. The caller never names a path, so there is no path to get wrong or to escape from, and the
 *    file returned is exactly the one the document's text and page numbers were taken from.
 * 2. `find` gives undefined, not an error, when there is no such file.
 * 3. Two files with the same contents are the same file: either may be returned.
 */
export interface SourceFileStore {
  find(sha256: string): Promise<SourceFile | undefined>;
}
