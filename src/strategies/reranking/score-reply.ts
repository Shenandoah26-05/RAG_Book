import { z } from "zod";

/** The one thing the model is asked for: `{"score": 7}`, a number from 0 to 10. */
const scoreObject = z.object({ score: z.number().min(0).max(10) });

/** A flat `{ ... }`: the answer has no nested objects, which keeps the search for it simple. */
const FLAT_OBJECT = /\{[^{}]*\}/g;

/**
 * Reads the score out of a model's reply, or gives undefined if there is none that can be trusted.
 *
 * Models do not always obey "reply with only JSON": they add a sentence before it, wrap it in a code
 * fence, or put two objects in one reply. So the reply is searched for flat `{...}` objects, and
 * the first one that parses and passes the schema wins. A score outside 0 to 10, a missing score,
 * a score written as text ("7") and a reply with no object at all are all undefined: an answer
 * that cannot be trusted is retried, not repaired.
 */
export function parseScoreReply(reply: string): number | undefined {
  for (const [candidate] of reply.matchAll(FLAT_OBJECT)) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = scoreObject.safeParse(json);
    if (parsed.success) return parsed.data.score;
  }
  return undefined;
}
