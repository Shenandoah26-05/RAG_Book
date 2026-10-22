import type { z } from "zod";

/**
 * Finds the JSON in a model's reply, or undefined if there is none. Models do not always obey
 * "reply with only JSON": they wrap it in a code fence or add a sentence around it. So the whole
 * reply is tried first, then the text from the first `{` to the last `}`.
 */
export function extractJson(reply: string): unknown {
  const text = reply.trim();
  const candidates = [text];
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open !== -1 && close > open) candidates.push(text.slice(open, close + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** The reply read as `schema`, or undefined if it is not JSON of that shape. Never repairs a reply. */
export function parseReply<T>(reply: string, schema: z.ZodType<T>): T | undefined {
  const json = extractJson(reply);
  if (json === undefined) return undefined;
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
