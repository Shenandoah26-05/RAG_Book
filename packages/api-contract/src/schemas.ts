import { z } from "zod";

// The wire format of the HTTP API (RAG-101): what a client may send, and what the server answers.
// Written once, here, and imported by both sides by the package name. The server maps its own
// domain types to these shapes at the edge (src/api/mappers.ts), so a refactor of the library cannot
// change what a browser receives by accident.

// ---- limits ----

/** The longest question the API accepts, in characters. */
export const MAX_QUESTION_CHARS = 2000;
/** The most chunks a request may ask for. */
export const MAX_K = 50;
/** The most earlier turns a request may carry. The server reads only the last few of them. */
export const MAX_HISTORY_TURNS = 10;
/**
 * The longest selected passage a question may carry, in characters. It goes into the prompt beside
 * the sources, and a local model has a small window, so it is about half a page.
 */
export const MAX_SELECTION_CHARS = 2000;
/** The longest earlier question or answer, in characters. */
export const MAX_TURN_CHARS = 8000;

// ---- identifiers ----

/** A document id: a lower-case version 5 UUID. */
export const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A chunk id: a SHA-256 in lower-case hex. */
export const CHUNK_ID = /^[0-9a-f]{64}$/;

export const docIdSchema = z.string().regex(DOC_ID, "must be a document id");
export const chunkIdSchema = z.string().regex(CHUNK_ID, "must be a chunk id (64 hex characters)");

// ---- requests ----

/** One earlier question and the answer it was given, so a follow-up can be understood. */
export const turnSchema = z.strictObject({
  question: z.string().max(MAX_TURN_CHARS),
  answer: z.string().max(MAX_TURN_CHARS),
});
export type Turn = z.infer<typeof turnSchema>;

const page = z.number().int().min(1);

/** Pages from `from` to `to`, both inclusive and both optional (a missing end is open). */
export const pageRangeSchema = z
  .strictObject({ from: page.optional(), to: page.optional() })
  .refine((r) => r.from !== undefined || r.to !== undefined, {
    error: "give `from`, `to` or both",
  })
  .refine((r) => r.from === undefined || r.to === undefined || r.from <= r.to, {
    error: "`from` must not be after `to`",
  });
export type PageRange = z.infer<typeof pageRangeSchema>;

/**
 * Which chunks an answer may use. Every part that is given must hold (there is no "or"). It is not
 * the library's filter type on purpose: the two can change independently, and the server translates.
 */
export const askFilterSchema = z.strictObject({
  /** Only these documents. */
  documents: z.array(docIdSchema).min(1).optional(),
  /** Only chunks made by these chunking strategies, e.g. "recursive". */
  strategies: z.array(z.string().min(1)).min(1).optional(),
  /** Only chunks under this chapter or section: the titles from the chapter down. */
  section: z.array(z.string().trim().min(1)).min(1).optional(),
  /** Only chunks that touch these pages. */
  pages: pageRangeSchema.optional(),
});
export type AskFilter = z.infer<typeof askFilterSchema>;

/**
 * A passage the reader selected on the page before asking ("explain this"). It is searched for as
 * well as the question, and the model is shown it as quoted context. It is not a source: answers still
 * cite the numbered sources, which normally include the passage's own chunk.
 */
export const selectionSchema = z.strictObject({
  /** The selected words, as the page shows them. */
  text: z.string().trim().min(1, "must not be blank").max(MAX_SELECTION_CHARS),
  /** The page the reader was on, when known. */
  page: page.optional(),
});
export type Selection = z.infer<typeof selectionSchema>;

/** The body of `POST /ask`. */
export const askRequestSchema = z.strictObject({
  question: z.string().trim().min(1, "must not be blank").max(MAX_QUESTION_CHARS),
  /** How many chunks to answer from. Absent: the server's default. */
  k: z.number().int().min(1).max(MAX_K).optional(),
  /** The conversation so far, oldest first. The server keeps none: the client sends it. */
  history: z.array(turnSchema).max(MAX_HISTORY_TURNS).optional(),
  filter: askFilterSchema.optional(),
  /**
   * Also send an `inspection` event: the chunks retrieval found, how reranking moved them, and the
   * prompt (RAG-105). Off unless asked, since it carries the whole prompt.
   */
  inspect: z.boolean().optional(),
  /** A passage the reader selected, to ask about. */
  selection: selectionSchema.optional(),
});
export type AskRequest = z.infer<typeof askRequestSchema>;

/** `GET /pages/:n`: the page number in the path, the document (when there are several) in the query. */
export const pageRequestSchema = z.strictObject({
  // digits only: `Number("1e2")` and `Number("0x10")` are numbers, but not page numbers
  n: z
    .string()
    .regex(/^[1-9]\d{0,8}$/, "must be a page number, 1 or more")
    .transform(Number),
  doc: docIdSchema.optional(),
});
export type PageRequest = z.infer<typeof pageRequestSchema>;

/** `GET /chunks/:id`. */
export const chunkRequestSchema = z.strictObject({ id: chunkIdSchema });
export type ChunkRequest = z.infer<typeof chunkRequestSchema>;

// ---- responses ----

/** Points an answer back to the passage it came from. `[n]` in the answer is `citations[n - 1]`. */
export const wireCitationSchema = z.strictObject({
  index: z.number().int().min(1),
  chunkId: chunkIdSchema,
  docId: docIdSchema,
  pageStart: page,
  pageEnd: page,
  /** Where the passage sits in the text of the document: half-open `[charStart, charEnd)`. */
  charStart: z.number().int().min(0),
  charEnd: z.number().int().min(0),
  /** The cited text, for display and highlighting. */
  quote: z.string(),
});
export type WireCitation = z.infer<typeof wireCitationSchema>;

const summaryValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** What one stage of the pipeline did and how long it took. */
export const wireStageSchema = z.strictObject({
  stage: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
  status: z.enum(["ok", "error"]),
  summary: z.record(z.string(), summaryValue),
  error: z.string().optional(),
});
export type WireStage = z.infer<typeof wireStageSchema>;

/** What the model and embedder calls made for the answer came to. */
export const wireUsageSchema = z.strictObject({
  calls: z.number().int().min(0),
  promptTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** Estimated: an embedder does not say how many tokens it was sent. */
  embeddedTokens: z.number().int().min(0),
  modelMs: z.number().min(0),
  /** Present when the server has a price table. */
  cost: z
    .strictObject({
      amount: z.number().min(0),
      currency: z.string(),
      /** Tokens of models with no price, which `amount` leaves out. */
      unpricedTokens: z.number().int().min(0),
    })
    .optional(),
});
export type WireUsage = z.infer<typeof wireUsageSchema>;

export const wireTraceSchema = z.strictObject({
  totalMs: z.number().min(0),
  stages: z.array(wireStageSchema),
  usage: wireUsageSchema.optional(),
});
export type WireTrace = z.infer<typeof wireTraceSchema>;

/** A retriever's own rank and score for a chunk, before the results were fused. */
export const wireFoundBySchema = z.strictObject({
  retriever: z.string(),
  rank: z.number().int().min(1),
  score: z.number(),
});
export type WireFoundBy = z.infer<typeof wireFoundBySchema>;

/**
 * What became of a retrieved chunk. `used` is in the prompt; `duplicate` and `over-budget` reached the
 * assembler and were left out; `cut` did not survive reranking.
 */
export const CHUNK_FATES = ["used", "duplicate", "over-budget", "cut"] as const;
export const chunkFateSchema = z.enum(CHUNK_FATES);
export type ChunkFate = z.infer<typeof chunkFateSchema>;

/** A chunk retrieval found for the question, and where it went from there. */
export const wireCandidateSchema = z.strictObject({
  chunkId: chunkIdSchema,
  pageStart: page,
  pageEnd: page,
  sectionPath: z.array(z.string()),
  /** The start of the text, whitespace folded: enough to recognise the passage. */
  snippet: z.string(),
  /** Where retrieval ranked it, 1 for the best, and the score it gave. */
  rank: z.number().int().min(1),
  score: z.number(),
  /** The `name` of the retriever that gave it to the reranker, e.g. "hybrid". */
  retriever: z.string(),
  /**
   * The base retrievers that found it on their own, with their own ranks. Empty when the retriever
   * does not report them. A parent chunk lists the retrievers that found its children.
   */
  foundBy: z.array(wireFoundBySchema),
  /** Its place after reranking, or null if the reranker dropped it. */
  finalRank: z.number().int().min(1).nullable(),
  /** The reranker's score for it, or null if the reranker dropped it. */
  finalScore: z.number().nullable(),
  fate: chunkFateSchema,
  /** The number it has in the prompt (`[n]`), for a chunk that was used. */
  source: z.number().int().min(1).optional(),
});
export type WireCandidate = z.infer<typeof wireCandidateSchema>;

/** The prompt, and how much of its token budget the sources took. */
export const wirePromptSchema = z.strictObject({
  /** `"<id>@<version>"` of the template. */
  version: z.string(),
  system: z.string(),
  user: z.string(),
  sourceTokens: z.number().int().min(0),
  budget: z.number().int().min(0),
  /** False when the book had no good enough source and the model was never called with this. */
  sent: z.boolean(),
});
export type WirePrompt = z.infer<typeof wirePromptSchema>;

/** What happened behind an answer, for the inspector (RAG-105). */
export const wireInspectionSchema = z.strictObject({
  candidates: z.array(wireCandidateSchema),
  prompt: wirePromptSchema,
});
export type WireInspection = z.infer<typeof wireInspectionSchema>;

/** `GET /pages/:n`: one page of the book, as text. */
export const pageResponseSchema = z.strictObject({
  docId: docIdSchema,
  title: z.string(),
  number: page,
  pageCount: page,
  text: z.string(),
  /** Where this page sits in the text of the whole document: half-open `[start, end)`. */
  span: z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(0) }),
});
export type PageResponse = z.infer<typeof pageResponseSchema>;

/** `GET /chunks/:id`: a passage of the book as the index holds it. */
export const chunkResponseSchema = z.strictObject({
  id: chunkIdSchema,
  docId: docIdSchema,
  text: z.string(),
  /** The larger chunk this one belongs to, for the parent-child strategy. */
  parentId: chunkIdSchema.optional(),
  pageStart: page,
  pageEnd: page,
  /** The titles from the chapter down to the deepest section. Empty when unknown. */
  sectionPath: z.array(z.string()),
  charStart: z.number().int().min(0),
  charEnd: z.number().int().min(0),
  strategy: z.string(),
});
export type ChunkResponse = z.infer<typeof chunkResponseSchema>;

/** The error codes the API answers with. They do not change meaning. */
export const ERROR_CODES = [
  "INVALID_REQUEST",
  "NOT_FOUND",
  "PROVIDER_UNAVAILABLE",
  "INDEX_UNAVAILABLE",
  "INTERNAL",
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** The body of every non-2xx answer, and the data of an `error` stream event. */
export const errorBodySchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string(),
  /** For a request that did not validate: what was wrong, where. */
  issues: z.array(z.strictObject({ path: z.string(), message: z.string() })).optional(),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

export const errorResponseSchema = z.strictObject({ error: errorBodySchema });
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

// ---- the stream of POST /ask ----

/** A piece of the answer, in order. Join the `text` of every token event to get the answer. */
export const tokenEventSchema = z.strictObject({
  event: z.literal("token"),
  data: z.strictObject({ text: z.string().min(1) }),
});
/** The sources the answer was written from. Empty when the book had nothing to answer with. */
export const citationsEventSchema = z.strictObject({
  event: z.literal("citations"),
  data: z.strictObject({ citations: z.array(wireCitationSchema) }),
});
/** What each stage did, and what the answer cost. */
export const traceEventSchema = z.strictObject({
  event: z.literal("trace"),
  data: z.strictObject({ trace: wireTraceSchema }),
});
/** The chunks and the prompt behind the answer. Sent only to a request that set `inspect`. */
export const inspectionEventSchema = z.strictObject({
  event: z.literal("inspection"),
  data: z.strictObject({ inspection: wireInspectionSchema }),
});
/** The last event of a successful answer, with the checks on the finished text. */
export const doneEventSchema = z.strictObject({
  event: z.literal("done"),
  data: z.strictObject({
    /** False when the book had no good enough source and the model was not asked. */
    answered: z.boolean(),
    refusal: z.string().optional(),
    /** The source numbers the answer cites, each once. */
    cited: z.array(z.number().int()),
    /** Cited numbers that are not sources: the answer cites something it was not given. */
    unknownCitations: z.array(z.number().int()),
    /** False if the stream was cut short, so the text checked was partial. */
    complete: z.boolean(),
  }),
});
/** The answer failed after it began. Nothing follows. */
export const errorEventSchema = z.strictObject({
  event: z.literal("error"),
  data: errorBodySchema,
});

/** Every event of the stream, as `{ event, data }`. A successful answer ends with `done`. */
export const askEventSchema = z.discriminatedUnion("event", [
  tokenEventSchema,
  citationsEventSchema,
  traceEventSchema,
  inspectionEventSchema,
  doneEventSchema,
  errorEventSchema,
]);
export type AskEvent = z.infer<typeof askEventSchema>;
export type AskEventName = AskEvent["event"];

// ---- the book, for the reader (RAG-102) ----

/** `GET /book`: the document in the query when the index holds several. */
export const bookRequestSchema = z.strictObject({ doc: docIdSchema.optional() });
export type BookRequest = z.infer<typeof bookRequestSchema>;

/**
 * One heading of the book and what is under it, as the table of contents shows it. `level` is the
 * depth (1 for a chapter); the page range covers the heading's whole section, subsections included.
 */
export const wireOutlineEntrySchema = z.strictObject({
  title: z.string(),
  level: z.number().int().min(1),
  pageStart: page,
  pageEnd: page,
  get children() {
    return z.array(wireOutlineEntrySchema);
  },
});
export type WireOutlineEntry = z.infer<typeof wireOutlineEntrySchema>;

/** `GET /book`: what a reader needs to open the book. */
export const bookResponseSchema = z.strictObject({
  docId: docIdSchema,
  title: z.string(),
  pageCount: page,
  /**
   * Whether the PDF itself can be fetched from `GET /book/pdf`. When false the pages are still
   * readable as text from `GET /pages/:n`, but cannot be drawn as in the original.
   */
  pdf: z.boolean(),
  /** The section tree. Empty when no headings were detected in the book. */
  outline: z.array(wireOutlineEntrySchema),
});
export type BookResponse = z.infer<typeof bookResponseSchema>;

// ---- feedback on an answer (RAG-106) ----

/** The longest note a reader may leave with a rating, in characters. */
export const MAX_FEEDBACK_NOTE_CHARS = 1000;
/** The most sources an answer's feedback may carry. */
export const MAX_FEEDBACK_CITATIONS = 50;
/** A random (version 4) UUID, which the web app makes once per answer. */
export const ANSWER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const FEEDBACK_RATINGS = ["up", "down"] as const;
export const feedbackRatingSchema = z.enum(FEEDBACK_RATINGS);
export type FeedbackRating = z.infer<typeof feedbackRatingSchema>;

/**
 * The body of `POST /feedback`: a rating of one answer, with the answer itself. The server keeps no
 * conversation, so the page that holds the answer sends it back.
 *
 * Sending feedback for the same `answerId` again replaces the earlier one (the rating changed, or a
 * note was added): the newest wins.
 */
export const feedbackRequestSchema = z.strictObject({
  /** Names the answer; made by the page, once per answer. */
  answerId: z.string().regex(ANSWER_ID, "must be a version 4 UUID"),
  rating: feedbackRatingSchema,
  note: z.string().trim().max(MAX_FEEDBACK_NOTE_CHARS).optional(),
  question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
  /** Empty for a question the book declined to answer. */
  answer: z.string().max(MAX_TURN_CHARS),
  /** Why the book declined, when it did. */
  refusal: z.string().max(MAX_TURN_CHARS).optional(),
  /** The book the question was asked of. */
  docId: docIdSchema.optional(),
  citations: z.array(wireCitationSchema).max(MAX_FEEDBACK_CITATIONS),
  trace: wireTraceSchema.optional(),
});
export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;

/** The answer to `POST /feedback`: the feedback is on disk. */
export const feedbackResponseSchema = z.strictObject({
  answerId: z.string(),
  saved: z.literal(true),
});
export type FeedbackResponse = z.infer<typeof feedbackResponseSchema>;
