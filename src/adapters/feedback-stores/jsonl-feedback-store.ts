import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { FeedbackEntry, FeedbackStore } from "../../core/index.js";

/**
 * Keeps feedback in one JSON Lines file, a line per entry, added at the end. Each line is complete
 * on its own, so a crash loses at most the line being written, `jq` and the promotion script
 * (`pnpm eval:promote`) read it a line at a time, and nothing ever rewrites what is there.
 *
 * Calls are written one after the other in the order they were made, so two readers rating at the
 * same moment cannot interleave their lines.
 */
export class JsonlFeedbackStore implements FeedbackStore {
  readonly location: string;
  #ready: Promise<void> | undefined;
  #queue: Promise<void> = Promise.resolve();

  /** @param file the path of the `.jsonl` file; its folder is created on first write */
  constructor(file: string) {
    this.location = file;
  }

  record(entry: FeedbackEntry): Promise<void> {
    // `JSON.stringify` escapes newlines, so an entry is always exactly one line
    const line = `${JSON.stringify(entry)}\n`;
    const written = this.#queue.then(async () => {
      await this.#folder();
      await appendFile(this.location, line, "utf8");
    });
    // a failed write must not stop the writes after it
    this.#queue = written.catch(() => undefined);
    return written;
  }

  #folder(): Promise<void> {
    this.#ready ??= mkdir(path.dirname(this.location), { recursive: true }).then(() => undefined);
    return this.#ready;
  }
}
