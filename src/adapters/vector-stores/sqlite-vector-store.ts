import { mkdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import path from "node:path";
import * as sqliteVec from "sqlite-vec";
import type {
  ChunkId,
  FilterClause,
  MetadataFilter,
  ScoredId,
  VectorRecord,
  VectorStore,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";

/** Passes `:memory:` to SQLite: a database that lives and dies with the store. */
export const SQLITE_IN_MEMORY = ":memory:";

const invalid = (message: string): RagError => new RagError("INVALID_ARGUMENT", message);

/** The column behind each field a filter can test. */
const COLUMNS = { docId: "doc_id", strategy: "strategy" } as const;

const isPage = (n: number | undefined): boolean =>
  n === undefined || (Number.isInteger(n) && n >= 1);

/** A section title as compared by a `section` clause: no surrounding spaces, no case. */
const fold = (title: string): string => title.trim().toLowerCase();

const toBlob = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);

/**
 * A vector store kept in a SQLite file, with the search done by the [sqlite-vec] extension.
 *
 * - **Exact, not approximate.** Each search scores every row that passes the filter with
 *   `vec_distance_cosine` and keeps the best `k` in SQL (`ORDER BY score DESC, id ASC LIMIT k`). It
 *   gives the same answers as `FlatVectorStore`, which is what the shared contract checks. The
 *   `vec0` virtual table is not used: it ranks by distance alone, so ties could not be ordered by id
 *   as the port requires, and one book is far too small to need its index.
 * - **Filters run first.** The `MetadataFilter` becomes a `WHERE` clause with bound parameters, so
 *   the filter never shrinks the `k` hits afterwards.
 * - **Survives restarts.** A file path keeps the index on disk; `:memory:` does not. The dimension
 *   is written to the file, and opening it with another one is an error rather than silent garbage.
 * - `upsert` is one transaction: a batch is stored whole or not at all.
 *
 * It uses Node's built-in `node:sqlite`, so there is no native module to compile.
 *
 * [sqlite-vec]: https://github.com/asg017/sqlite-vec
 */
export class SqliteVectorStore implements VectorStore {
  readonly dimensions: number;
  readonly #db: DatabaseSync;

  /**
   * @param location a file path (its folder is created if needed) or `SQLITE_IN_MEMORY`
   * @throws RagError INVALID_ARGUMENT if `dimensions` is not a whole number of 1 or more, or the
   *   file already holds vectors of a different length
   */
  constructor(dimensions: number, location: string = SQLITE_IN_MEMORY) {
    if (!Number.isInteger(dimensions) || dimensions < 1) {
      throw invalid(`dimensions must be a whole number of 1 or more, got ${String(dimensions)}`);
    }
    this.dimensions = dimensions;
    if (location !== SQLITE_IN_MEMORY) mkdirSync(path.dirname(location), { recursive: true });
    this.#db = new DatabaseSync(location, { allowExtension: true });
    try {
      sqliteVec.load(this.#db);
      this.#open();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  upsert(records: readonly VectorRecord[]): Promise<void> {
    return this.#run(() => {
      for (const record of records) this.#assertUsable(record.vector, `record ${record.id}`);
      if (records.length === 0) return;
      const put = this.#db.prepare(
        `INSERT OR REPLACE INTO records
           (id, vector, doc_id, strategy, page_start, page_end, section_path)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      this.#db.exec("BEGIN");
      try {
        for (const { id, vector, metadata } of records) {
          put.run(
            id,
            toBlob(vector),
            metadata.docId,
            metadata.strategy,
            metadata.pageStart,
            metadata.pageEnd,
            // folded once here, so a filter can compare titles with plain equality in SQL
            JSON.stringify(metadata.sectionPath.map(fold)),
          );
        }
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  search(
    query: Float32Array,
    k: number,
    filter: MetadataFilter = [],
  ): Promise<readonly ScoredId[]> {
    return this.#run(() => {
      this.#assertUsable(query, "query");
      if (!Number.isInteger(k) || k < 1) {
        throw invalid(`k must be a whole number of 1 or more, got ${String(k)}`);
      }
      const where = filter.map(toSql);
      const params = where.flatMap((w) => w.params);
      // A vector with no length points nowhere: vec_distance_cosine gives NULL, which scores 0
      // (the same as FlatVectorStore) instead of poisoning the ranking.
      const sql = `SELECT id, COALESCE(1.0 - vec_distance_cosine(vector, ?), 0.0) AS score
                   FROM records
                   ${where.length > 0 ? `WHERE ${where.map((w) => w.sql).join(" AND ")}` : ""}
                   ORDER BY score DESC, id ASC
                   LIMIT ?`;
      const rows = this.#db.prepare(sql).all(toBlob(query), ...params, k);
      return rows.map((row) => ({ id: row["id"] as ChunkId, score: row["score"] as number }));
    });
  }

  delete(ids: readonly ChunkId[]): Promise<void> {
    return this.#run(() => {
      if (ids.length === 0) return;
      const remove = this.#db.prepare("DELETE FROM records WHERE id = ?");
      this.#db.exec("BEGIN");
      try {
        for (const id of ids) remove.run(id);
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  count(): Promise<number> {
    return this.#run(() => {
      const row = this.#db.prepare("SELECT COUNT(*) AS n FROM records").get();
      return Number(row?.["n"] ?? 0);
    });
  }

  /** Releases the file. The store cannot be used afterwards. */
  close(): void {
    this.#db.close();
  }

  /** Creates the tables on a new file; on an existing one, checks the dimension matches. */
  #open(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS store_info (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (
        id         TEXT PRIMARY KEY,
        vector     BLOB NOT NULL,
        doc_id     TEXT NOT NULL,
        strategy   TEXT NOT NULL,
        page_start INTEGER NOT NULL,
        page_end   INTEGER NOT NULL,
        section_path TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS records_doc ON records (doc_id);
    `);
    // a file made before section filters existed has no such column; its rows get an empty path,
    // so they match no section until the index is rebuilt
    const columns = this.#db.prepare("PRAGMA table_info(records)").all();
    if (!columns.some((column) => column["name"] === "section_path")) {
      this.#db.exec("ALTER TABLE records ADD COLUMN section_path TEXT NOT NULL DEFAULT '[]'");
    }
    const row = this.#db.prepare("SELECT value FROM store_info WHERE key = 'dimensions'").get();
    if (row === undefined) {
      this.#db
        .prepare("INSERT INTO store_info (key, value) VALUES ('dimensions', ?)")
        .run(String(this.dimensions));
    } else if (Number(row["value"]) !== this.dimensions) {
      throw invalid(
        `This index holds ${String(row["value"])}-dimension vectors, but the store was opened with ${this.dimensions.toString()}. Delete the file or use the matching embedding model.`,
      );
    }
  }

  #assertUsable(vector: Float32Array, what: string): void {
    if (vector.length !== this.dimensions) {
      throw invalid(
        `${what} has ${vector.length.toString()} dimensions, but this store holds ${this.dimensions.toString()}`,
      );
    }
    if (!vector.every(Number.isFinite)) {
      throw invalid(`${what} holds NaN or Infinity`);
    }
  }

  /** SQLite is synchronous; the port is async. Errors become rejections, never throws. */
  #run<T>(work: () => T): Promise<T> {
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

interface Sql {
  readonly sql: string;
  readonly params: SQLInputValue[];
}

/** One filter clause as a SQL condition. Values are always bound, never put into the text. */
function toSql(clause: FilterClause): Sql {
  switch (clause.kind) {
    case "equals":
      return { sql: `${COLUMNS[clause.field]} = ?`, params: [clause.value] };
    case "in":
      // `IN ()` is not valid SQL; an empty list matches nothing
      if (clause.values.length === 0) return { sql: "0", params: [] };
      return {
        sql: `${COLUMNS[clause.field]} IN (${clause.values.map(() => "?").join(", ")})`,
        params: [...clause.values],
      };
    case "section": {
      // the stored path starts with the clause's path, title by title (a missing title is NULL)
      const titles = clause.path.map(fold);
      if (titles.length === 0 || titles.some((title) => title === "")) {
        throw invalid(
          `Invalid section path ${JSON.stringify(clause.path)}: give at least one title, none blank`,
        );
      }
      return {
        sql: titles
          .map((_, i) => `json_extract(section_path, '$[${i.toString()}]') = ?`)
          .join(" AND "),
        params: titles,
      };
    }
    case "pageRange": {
      const { from, to } = clause;
      if (!isPage(from) || !isPage(to) || (from !== undefined && to !== undefined && from > to)) {
        throw invalid(
          `Invalid page range { from: ${String(from)}, to: ${String(to)} }: pages are whole numbers of 1 or more and from must not exceed to`,
        );
      }
      // the chunk touches the range if it ends on or after `from` and starts on or before `to`
      const parts: Sql[] = [];
      if (from !== undefined) parts.push({ sql: "page_end >= ?", params: [from] });
      if (to !== undefined) parts.push({ sql: "page_start <= ?", params: [to] });
      return {
        sql: parts.length > 0 ? parts.map((p) => p.sql).join(" AND ") : "1",
        params: parts.flatMap((p) => p.params),
      };
    }
  }
}
