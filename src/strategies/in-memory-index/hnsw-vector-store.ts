import type {
  ChunkId,
  ChunkMetadata,
  MetadataFilter,
  ScoredId,
  VectorRecord,
  VectorStore,
} from "../../core/index.js";
import { RagError } from "../../shared/index.js";
import { dot, normalise } from "../ranking/index.js";
import { BinaryHeap } from "./binary-heap.js";
import { assertValidFilter, matchesFilter } from "./metadata-filter.js";
import { ranksAbove } from "./top-k.js";

/** The knobs of the graph. The defaults are the usual ones from the HNSW paper and hnswlib. */
export interface HnswOptions {
  /** Links kept per node on the upper layers (twice as many on layer 0). More = better recall, more memory. */
  readonly m?: number;
  /** How many candidates are tracked while inserting. More = better graph, slower build. */
  readonly efConstruction?: number;
  /** How many candidates are tracked while searching. More = better recall, slower queries. */
  readonly efSearch?: number;
  /** Seed for the random layer of each node, so the same inserts always build the same graph. */
  readonly seed?: number;
}

interface Node {
  readonly id: ChunkId;
  /** Unit length (or all zeros), so a dot product is the cosine similarity. */
  readonly vector: Float32Array;
  readonly metadata: ChunkMetadata;
  /** `links[level]` holds the indexes of this node's neighbours on that level. */
  readonly links: number[][];
  /** Deleted or replaced. Still a stepping stone for searches, but never returned. */
  dead: boolean;
}

interface Candidate {
  readonly node: number;
  readonly sim: number;
}

const invalid = (message: string): RagError => new RagError("INVALID_ARGUMENT", message);

const wholeNumber = (name: string, value: number, min: number): number => {
  if (!Number.isInteger(value) || value < min) {
    throw invalid(
      `${name} must be a whole number of ${min.toString()} or more, got ${String(value)}`,
    );
  }
  return value;
};

// A small seeded generator (mulberry32): the same seed always gives the same numbers.
function seededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Approximate nearest-neighbour search with a Hierarchical Navigable Small World graph (Malkov &
 * Yashunin, 2016), written by hand for RAG-044. It is a `VectorStore` like any other, so it can be
 * checked against `FlatVectorStore`, the exact reference.
 *
 * How it works:
 * - Every vector is a node. Each node is linked to a few near neighbours, and a few nodes also live
 *   on higher, sparser layers (a node's top layer is random: each layer up is ~`m` times rarer).
 * - A search starts at the top, hops greedily towards the query, drops a layer and repeats. On the
 *   bottom layer it widens to `efSearch` candidates. It compares the query with a few hundred
 *   vectors instead of all of them, but it can miss a true neighbour: **the results are approximate**.
 * - Vectors are normalised when stored, so the score (a dot product) equals the cosine similarity.
 * - `delete` and replacing an id leave a dead node in the graph (taking it out would break paths
 *   through it). Dead nodes are never returned, and the graph is rebuilt once most nodes are dead.
 * - A filter is applied while walking the graph: only matching nodes enter the result set, though
 *   the walk still passes through the others. A filter that very few chunks satisfy makes the walk
 *   long, up to a full scan.
 *
 * Lives in memory only.
 */
export class HnswVectorStore implements VectorStore {
  readonly dimensions: number;
  readonly m: number;
  readonly efConstruction: number;
  readonly #seed: number;
  #efSearch: number;
  #random: () => number;

  #nodes: Node[] = [];
  readonly #byId = new Map<ChunkId, number>();
  #entry = -1;
  #topLevel = -1;
  #dead = 0;
  #comparisons = 0;

  /** @throws RagError INVALID_ARGUMENT for dimensions or options that are not whole numbers in range */
  constructor(dimensions: number, options: HnswOptions = {}) {
    this.dimensions = wholeNumber("dimensions", dimensions, 1);
    this.m = wholeNumber("m", options.m ?? 16, 2);
    this.efConstruction = wholeNumber("efConstruction", options.efConstruction ?? 200, 1);
    this.#efSearch = wholeNumber("efSearch", options.efSearch ?? 64, 1);
    this.#seed = options.seed ?? 42;
    this.#random = seededRandom(this.#seed);
  }

  /** Candidates tracked on the bottom layer during a search (a search never uses less than `k`). */
  get efSearch(): number {
    return this.#efSearch;
  }

  set efSearch(value: number) {
    this.#efSearch = wholeNumber("efSearch", value, 1);
  }

  /** Vector comparisons made since the store was created. Compare with `count()` to see the saving. */
  get comparisons(): number {
    return this.#comparisons;
  }

  upsert(records: readonly VectorRecord[]): Promise<void> {
    try {
      for (const record of records) this.#assertUsable(record.vector, `record ${record.id}`);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    for (const record of records) {
      this.#kill(record.id);
      this.#insert(record);
    }
    this.#rebuildIfMostlyDead();
    return Promise.resolve();
  }

  search(
    query: Float32Array,
    k: number,
    filter: MetadataFilter = [],
  ): Promise<readonly ScoredId[]> {
    try {
      this.#assertUsable(query, "query");
      wholeNumber("k", k, 1);
      assertValidFilter(filter);
      return Promise.resolve(this.#search(normalise(query), k, filter));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  delete(ids: readonly ChunkId[]): Promise<void> {
    for (const id of ids) this.#kill(id);
    this.#rebuildIfMostlyDead();
    return Promise.resolve();
  }

  count(): Promise<number> {
    return Promise.resolve(this.#byId.size);
  }

  // ---- search -------------------------------------------------------------------------------

  #search(query: Float32Array, k: number, filter: MetadataFilter): ScoredId[] {
    if (this.#entry < 0 || this.#byId.size === 0) return [];
    let entries = [this.#candidate(query, this.#entry)];
    for (let level = this.#topLevel; level >= 1; level -= 1) {
      entries = this.#searchLayer(query, entries, 1, level);
    }
    const accept =
      filter.length === 0
        ? (node: Node): boolean => !node.dead
        : (node: Node): boolean => !node.dead && matchesFilter(node.metadata, filter);
    return this.#searchLayer(query, entries, Math.max(this.#efSearch, k), 0, accept)
      .map((c) => ({ id: this.#node(c.node).id, score: c.sim }))
      .sort((a, b) => (ranksAbove(a, b) ? -1 : ranksAbove(b, a) ? 1 : 0))
      .slice(0, k);
  }

  /**
   * Best-first walk of one layer. `candidates` is what is left to explore (best first); `found` is
   * the best `ef` accepted nodes so far (worst first, so the worst is easy to drop). The walk stops
   * when the best unexplored node is worse than the worst one found.
   */
  #searchLayer(
    query: Float32Array,
    entries: readonly Candidate[],
    ef: number,
    level: number,
    accept: (node: Node) => boolean = () => true,
  ): Candidate[] {
    const visited = new Set<number>();
    const candidates = new BinaryHeap<Candidate>((a, b) => this.#better(a, b));
    const found = new BinaryHeap<Candidate>((a, b) => this.#better(b, a));
    for (const entry of entries) {
      visited.add(entry.node);
      candidates.push(entry);
      if (accept(this.#node(entry.node))) found.push(entry);
    }
    while (found.size > ef) found.pop();

    for (let next = candidates.pop(); next !== undefined; next = candidates.pop()) {
      const worst = found.peek();
      if (found.size >= ef && worst !== undefined && next.sim < worst.sim) break;
      for (const neighbour of this.#node(next.node).links[level] ?? []) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        const candidate = this.#candidate(query, neighbour);
        const bar = found.peek();
        if (found.size < ef || (bar !== undefined && candidate.sim > bar.sim)) {
          candidates.push(candidate);
          if (accept(this.#node(neighbour))) {
            found.push(candidate);
            if (found.size > ef) found.pop();
          }
        }
      }
    }
    return found.toArray().sort((a, b) => (this.#better(a, b) ? -1 : this.#better(b, a) ? 1 : 0));
  }

  // ---- building the graph -------------------------------------------------------------------

  #insert(record: VectorRecord): void {
    const vector = normalise(record.vector);
    const level = Math.floor(-Math.log(1 - this.#random()) / Math.log(this.m));
    const links: number[][] = Array.from({ length: level + 1 }, () => []);
    const index = this.#nodes.length;
    this.#nodes.push({ id: record.id, vector, metadata: record.metadata, links, dead: false });
    this.#byId.set(record.id, index);

    if (this.#entry < 0) {
      this.#entry = index;
      this.#topLevel = level;
      return;
    }
    let entries = [this.#candidate(vector, this.#entry)];
    for (let l = this.#topLevel; l > level; l -= 1) {
      entries = this.#searchLayer(vector, entries, 1, l);
    }
    for (let l = Math.min(level, this.#topLevel); l >= 0; l -= 1) {
      const found = this.#searchLayer(vector, entries, this.efConstruction, l);
      const chosen = this.#selectNeighbours(found, this.m);
      links[l] = chosen.map((c) => c.node);
      for (const { node } of chosen) this.#link(node, index, l);
      entries = found;
    }
    if (level > this.#topLevel) {
      this.#entry = index;
      this.#topLevel = level;
    }
  }

  /** Adds `to` to the links of `from`; if `from` now has too many, keeps the best-spread ones. */
  #link(from: number, to: number, level: number): void {
    const node = this.#node(from);
    const links = node.links[level];
    if (links === undefined) return;
    links.push(to);
    const limit = level === 0 ? 2 * this.m : this.m;
    if (links.length <= limit) return;
    const scored = links.map((n) => this.#candidate(node.vector, n));
    scored.sort((a, b) => (this.#better(a, b) ? -1 : this.#better(b, a) ? 1 : 0));
    node.links[level] = this.#selectNeighbours(scored, limit).map((c) => c.node);
  }

  /**
   * Picks up to `max` neighbours from `sorted` (best first) with the paper's heuristic: skip a
   * candidate that is closer to an already chosen neighbour than to the new node, because the path
   * through that neighbour already reaches it. This spreads the links in different directions
   * instead of wasting them on one tight cluster. If that leaves room, the skipped ones fill it.
   */
  #selectNeighbours(sorted: readonly Candidate[], max: number): Candidate[] {
    const chosen: Candidate[] = [];
    const skipped: Candidate[] = [];
    for (const candidate of sorted) {
      if (chosen.length >= max) break;
      const vector = this.#node(candidate.node).vector;
      const spread = chosen.every((c) => dot(vector, this.#node(c.node).vector) < candidate.sim);
      (spread ? chosen : skipped).push(candidate);
    }
    return chosen.concat(skipped.slice(0, max - chosen.length));
  }

  // ---- deleting -----------------------------------------------------------------------------

  #kill(id: ChunkId): void {
    const index = this.#byId.get(id);
    if (index === undefined) return;
    this.#node(index).dead = true;
    this.#byId.delete(id);
    this.#dead += 1;
  }

  /** Once more than half the nodes are dead, the graph is rebuilt from the live ones. */
  #rebuildIfMostlyDead(): void {
    if (this.#dead * 2 <= this.#nodes.length) return;
    const live = this.#nodes.filter((n) => !n.dead);
    this.#nodes = [];
    this.#byId.clear();
    this.#entry = -1;
    this.#topLevel = -1;
    this.#dead = 0;
    this.#random = seededRandom(this.#seed);
    for (const node of live) {
      this.#insert({ id: node.id, vector: node.vector, metadata: node.metadata });
    }
  }

  // ---- helpers ------------------------------------------------------------------------------

  #node(index: number): Node {
    const node = this.#nodes[index];
    if (node === undefined)
      throw new RagError("INTERNAL", `HNSW node ${index.toString()} is missing`);
    return node;
  }

  #candidate(query: Float32Array, node: number): Candidate {
    this.#comparisons += 1;
    return { node, sim: dot(query, this.#node(node).vector) };
  }

  /** `a` is closer to the query than `b`: higher similarity, or the lower id on a tie. */
  #better(a: Candidate, b: Candidate): boolean {
    return ranksAbove(
      { id: this.#node(a.node).id, score: a.sim },
      { id: this.#node(b.node).id, score: b.sim },
    );
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
}
