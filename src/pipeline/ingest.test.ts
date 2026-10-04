import { describe, expect, it } from "vitest";
import type {
  Cleaner,
  DocId,
  DocumentLoader,
  DocumentStore,
  ParsedDocument,
  SectionDetector,
} from "../core/index.js";
import { createJsonLogger, makeDocId, RagError } from "../shared/index.js";
import { makeDocument } from "../testing/make-document.testing.js";
import { ingest } from "./ingest.js";
import type { IngestDeps } from "./ingest.js";

const FILE = "data/raw/book.pdf";
const SHA = "a".repeat(64);
const DOC_ID = makeDocId(SHA);

/** Everything the pipeline touches, as fakes that record what happened to them. */
function setup(options: { stored?: boolean; loadedId?: DocId; hash?: string } = {}) {
  const calls: string[] = [];
  const saved: ParsedDocument[] = [];
  const stored = new Set<DocId>(options.stored === true ? [DOC_ID] : []);
  const logs: Record<string, unknown>[] = [];

  const loader: DocumentLoader = {
    name: "fake-loader",
    load: () => {
      calls.push("load");
      return Promise.resolve({
        ...makeDocument(["Chapter\ntext", "more text"]),
        id: options.loadedId ?? DOC_ID,
      });
    },
  };
  const cleaner: Cleaner = {
    name: "fake-cleaner",
    clean: (doc) => {
      calls.push("clean");
      return doc;
    },
  };
  const detector: SectionDetector = {
    name: "fake-detector",
    detect: (doc) => {
      calls.push("detect");
      const title = { start: 0, end: 7 };
      const sections = [
        {
          title: "A",
          level: 1,
          pageStart: 1,
          pageEnd: 2,
          span: title,
          titleSpan: title,
          children: [
            {
              title: "A.1",
              level: 2,
              pageStart: 1,
              pageEnd: 1,
              span: title,
              titleSpan: title,
              children: [],
            },
          ],
        },
        {
          title: "B",
          level: 1,
          pageStart: 2,
          pageEnd: 2,
          span: title,
          titleSpan: title,
          children: [],
        },
      ];
      return { ...doc, sections };
    },
  };
  const store: DocumentStore = {
    has: (id) => Promise.resolve(stored.has(id)),
    load: () => Promise.resolve(undefined),
    save: (doc) => {
      calls.push("save");
      saved.push(doc);
      stored.add(doc.id);
      return Promise.resolve(`/store/${doc.id}.json`);
    },
    locationOf: (id) => `/store/${id}.json`,
  };

  const deps: IngestDeps = {
    loader,
    cleaner,
    detector,
    store,
    logger: createJsonLogger({
      level: "debug",
      write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
    }),
    hashFile: () => {
      calls.push("hash");
      return Promise.resolve(options.hash ?? SHA);
    },
  };
  return { deps, calls, saved, logs, stored };
}

describe("ingest", () => {
  it("loads, cleans, detects sections and saves, in that order", async () => {
    const { deps, calls } = setup();
    await ingest(deps, FILE);
    expect(calls).toEqual(["hash", "load", "clean", "detect", "save"]);
  });

  it("returns the id, where it was stored, and the page and section counts", async () => {
    const { deps } = setup();
    const result = await ingest(deps, FILE);

    expect(result).toMatchObject({
      status: "ingested",
      docId: DOC_ID,
      location: `/store/${DOC_ID}.json`,
      pages: 2,
      sections: 3, // A, its child A.1, and B
    });
    expect(result.status === "ingested" && result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("saves the document after cleaning and section detection, not the raw one", async () => {
    const { deps, saved } = setup();
    await ingest(deps, FILE);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.sections).toHaveLength(2);
  });

  it("does nothing the second time, because the stored result is for the same file hash", async () => {
    const { deps, calls } = setup();
    const first = await ingest(deps, FILE);
    calls.length = 0;
    const second = await ingest(deps, FILE);

    expect(first.status).toBe("ingested");
    expect(second).toEqual({
      status: "skipped",
      docId: DOC_ID,
      location: `/store/${DOC_ID}.json`,
    });
    expect(calls).toEqual(["hash"]); // only the hash: no load, clean, detect or save
  });

  it("skips when a result was stored by an earlier run", async () => {
    const { deps, calls } = setup({ stored: true });
    expect((await ingest(deps, FILE)).status).toBe("skipped");
    expect(calls).toEqual(["hash"]);
  });

  it("processes the file again with force, even if a result is stored", async () => {
    const { deps, calls, saved } = setup({ stored: true });
    const result = await ingest(deps, FILE, { force: true });

    expect(result.status).toBe("ingested");
    expect(calls).toEqual(["hash", "load", "clean", "detect", "save"]);
    expect(saved).toHaveLength(1);
  });

  it("treats force: false like no force", async () => {
    const { deps } = setup({ stored: true });
    expect((await ingest(deps, FILE, { force: false })).status).toBe("skipped");
  });

  it("a different file (different hash) is a different document, and is processed", async () => {
    const { deps, calls } = setup({
      stored: true,
      hash: "b".repeat(64),
      loadedId: makeDocId("b".repeat(64)),
    });
    const result = await ingest(deps, FILE);

    expect(result.status).toBe("ingested");
    expect(result.docId).toBe(makeDocId("b".repeat(64)));
    expect(calls).toContain("load");
  });

  it("fails, and saves nothing, if the file changed between hashing and reading it", async () => {
    const { deps, saved, calls } = setup({ loadedId: makeDocId("c".repeat(64)) });
    const error = await ingest(deps, FILE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RagError);
    expect((error as RagError).code).toBe("INGESTION_FAILED");
    expect((error as RagError).message).toContain("changed while it was being read");
    expect(saved).toEqual([]);
    expect(calls).not.toContain("clean");
  });

  it("logs the page count, the section count and the duration", async () => {
    const { deps, logs } = setup();
    await ingest(deps, FILE);

    const done = logs.find((l) => l["message"] === "ingested");
    expect(done).toMatchObject({
      file: FILE,
      pages: 2,
      sections: 3,
      location: `/store/${DOC_ID}.json`,
    });
    expect(typeof done?.["durationMs"]).toBe("number");
  });

  it("logs that it skipped, with the file and where the stored result is", async () => {
    const { deps, logs } = setup({ stored: true });
    await ingest(deps, FILE);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "info", file: FILE, location: `/store/${DOC_ID}.json` });
    expect(String(logs[0]?.["message"])).toContain("skipping");
  });

  it("does not run the later steps if loading fails", async () => {
    const { deps, calls } = setup();
    const failing = {
      ...deps,
      loader: {
        name: "x",
        load: () => Promise.reject(new RagError("INGESTION_FAILED", "bad pdf")),
      },
    };
    await expect(ingest(failing, FILE)).rejects.toThrow("bad pdf");
    expect(calls).toEqual(["hash"]);
  });

  it("does not store anything if cleaning fails", async () => {
    const { deps, saved } = setup();
    const failing = {
      ...deps,
      cleaner: {
        name: "x",
        clean: () => {
          throw new Error("boom");
        },
      },
    };
    await expect(ingest(failing, FILE)).rejects.toThrow("boom");
    expect(saved).toEqual([]);
  });
});
