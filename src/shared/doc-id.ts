import { v5, validate, version } from "uuid";
import type { DocId } from "../core/index.js";

/**
 * The namespace for document ids. Any UUID works, as long as it never changes: it is mixed into
 * every id, so changing it would give every document a new id and every stored document would be
 * processed again.
 */
const DOC_ID_NAMESPACE = "3f2b8a1e-7c4d-4e9a-b5d6-1a2c3e4f5a6b";

/**
 * Id of a document: a version 5 (name-based) UUID of the SHA-256 of its file.
 *
 * Unlike a random UUID, a name-based one can be worked out again from the same input. The same
 * file therefore always gets the same id, wherever it lives and whatever it is called, which is
 * how a PDF that was already processed is recognised. A file with different contents gets a
 * different id.
 */
export function makeDocId(fileSha256: string): DocId {
  return v5(fileSha256, DOC_ID_NAMESPACE) as DocId;
}

/**
 * Whether a string is a document id: a well-formed version 5 UUID in lower case. Use it before an
 * id from outside (a command line, a file) is trusted, for instance before it becomes part of a
 * file name.
 *
 * Lower case only, so an id has a single spelling: "ABC..." and "abc..." would be two different
 * files on a case-sensitive disk, and the same file on a case-insensitive one.
 */
export function isDocId(value: string): value is DocId {
  return validate(value) && version(value) === 5 && value === value.toLowerCase();
}
