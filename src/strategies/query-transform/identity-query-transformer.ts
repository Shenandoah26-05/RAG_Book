import type { Query, QueryTransformer } from "../../core/index.js";
import { RagError } from "../../shared/index.js";

/** No transformation: the question goes to retrieval exactly as it was asked. */
export class IdentityQueryTransformer implements QueryTransformer {
  readonly name = "identity";

  transform(query: Query): Promise<Query> {
    if (query.text.trim() === "") {
      return Promise.reject(new RagError("INVALID_ARGUMENT", "The question is blank"));
    }
    return Promise.resolve(query);
  }
}
