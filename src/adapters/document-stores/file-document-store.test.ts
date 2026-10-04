import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocId, ParsedDocument, Section } from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { makeDocument } from "../../testing/make-document.testing.js";
import { FileDocumentStore } from "./file-document-store.js";

const heading = (title: string, start: number, children: Section[] = []): Section => ({
  title,
  level: children.length > 0 ? 1 : 2,
  pageStart: 1,
  pageEnd: 2,
  span: { start, end: start + 10 },
  titleSpan: { start, end: start + title.length },
  children,
});

/** A document with text items, a font, and a nested section tree. */
function sampleDocument(): ParsedDocument {
  const doc = makeDocument(["Chapter One\nsome body text", "1.1 Sub\nmore body text"], {
    fontSizeOf: (line) => (line === "Chapter One" ? 24 : 12),
    isBold: (line) => line === "Chapter One",
  });
  return { ...doc, sections: [heading("Chapter One", 0, [heading("1.1 Sub", 29)])] };
}

describe("FileDocumentStore", () => {
  let dir: string;
  let store: FileDocumentStore;
  beforeEach(async () => {
    dir = path.join(await mkdtemp(path.join(tmpdir(), "rag-store-")), "processed");
    store = new FileDocumentStore(dir, () => new Date("2026-10-04T12:00:00.000Z"));
  });
  afterEach(async () => {
    await rm(path.dirname(dir), { recursive: true, force: true });
  });

  it("saves a document as <docId>.json, creating the folder, and returns where it went", async () => {
    const doc = sampleDocument();
    const location = await store.save(doc);

    expect(location).toBe(path.join(dir, `${doc.id}.json`));
    expect(store.locationOf(doc.id)).toBe(location);
    expect(await readdir(dir)).toEqual([`${doc.id}.json`]);
  });

  it("loads back exactly what was saved, sections and text items included", async () => {
    const doc = sampleDocument();
    await store.save(doc);
    expect(await store.load(doc.id)).toEqual(doc);
  });

  it("says whether a document is stored", async () => {
    const doc = sampleDocument();
    expect(await store.has(doc.id)).toBe(false);
    await store.save(doc);
    expect(await store.has(doc.id)).toBe(true);
  });

  it("gives undefined for a document that is not stored", async () => {
    expect(await store.load(sampleDocument().id)).toBeUndefined();
  });

  it("replaces an earlier document with the same id", async () => {
    const doc = sampleDocument();
    await store.save(doc);
    await store.save({ ...doc, title: "Renamed" });
    expect((await store.load(doc.id))?.title).toBe("Renamed");
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("leaves no temporary file behind", async () => {
    await store.save(sampleDocument());
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("writes a readable header: format version and when it was ingested", async () => {
    const doc = sampleDocument();
    const file = await store.save(doc);
    const json = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(json).toMatchObject({ version: 2, ingestedAt: "2026-10-04T12:00:00.000Z" });
    expect(Object.keys(json)).toEqual(["version", "ingestedAt", "document"]);
  });

  it("rejects stored data that is not valid JSON, naming the file and the fix", async () => {
    const doc = sampleDocument();
    await store.save(doc);
    await writeFile(store.locationOf(doc.id), "{ truncated");

    const error = await store.load(doc.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RagError);
    expect((error as RagError).code).toBe("INGESTION_FAILED");
    expect((error as RagError).message).toContain(`${doc.id}.json`);
    expect((error as RagError).message).toContain("damaged");
  });

  it("rejects stored data of the wrong shape or version, and suggests --force", async () => {
    const doc = sampleDocument();
    await store.save(doc);
    await writeFile(store.locationOf(doc.id), JSON.stringify({ version: 99, document: {} }));

    const error = await store.load(doc.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RagError);
    expect((error as RagError).message).toContain("--force");
  });

  it("rejects a document whose pages are damaged", async () => {
    const doc = sampleDocument();
    const file = await store.save(doc);
    const json = JSON.parse(await readFile(file, "utf8")) as { document: { pages: unknown[] } };
    json.document.pages[0] = { number: "one" };
    await writeFile(file, JSON.stringify(json));
    await expect(store.load(doc.id)).rejects.toThrow(/damaged/);
  });

  it("names the file after the document's UUID", async () => {
    const doc = sampleDocument();
    const location = await store.save(doc);
    expect(path.basename(location)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/,
    );
  });

  it("reports a file from the earlier format (version 1, with hash ids) as another version", async () => {
    const doc = sampleDocument();
    await store.save(doc);
    const old = {
      version: 1,
      ingestedAt: "2026-10-03T00:00:00.000Z",
      document: { ...doc, id: "a".repeat(64) },
    };
    await writeFile(store.locationOf(doc.id), JSON.stringify(old));

    const error = await store.load(doc.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RagError);
    expect((error as RagError).message).toContain("another version");
    expect((error as RagError).message).toContain("--force");
  });

  it("rejects a stored document whose id is not a UUID", async () => {
    const doc = sampleDocument();
    const file = await store.save(doc);
    const json = JSON.parse(await readFile(file, "utf8")) as { document: { id: string } };
    json.document.id = "not-an-id";
    await writeFile(file, JSON.stringify(json));
    await expect(store.load(doc.id)).rejects.toThrow(/document id/);
  });

  it.each([
    "../escape",
    "..\\escape",
    "abc",
    "",
    "a".repeat(64), // a SHA-256 hash: what ids used to be
    "3f2b8a1e-7c4d-4e9a-b5d6-1a2c3e4f5a6b", // a UUID, but a random (version 4) one
    `${sampleDocument().id}/..`,
    `../${sampleDocument().id}`,
  ])(
    "refuses an id that is not a document id, so it can never name another file: %j",
    async (id) => {
      const bad = id as DocId;
      expect(() => store.locationOf(bad)).toThrow(RagError);
      await expect(store.has(bad)).rejects.toThrow(/Not a document id/);
      await expect(store.load(bad)).rejects.toThrow(RagError);
    },
  );
});
