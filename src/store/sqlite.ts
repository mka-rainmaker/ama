import { DatabaseSync } from "node:sqlite";
import type {
  EdgeKind,
  EdgeProvenance,
  GraphEdge,
  GraphNode,
  NodeKind,
  Tier,
} from "../graph/index.js";
import type { FileMeta, Store } from "./types.js";

interface FileRow {
  path: string;
  size: number;
  mtime_ms: number;
  hash: string;
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  file: string;
  qualified_name: string;
  start_line: number | null;
  end_line: number | null;
  tier: string;
}

interface EdgeRow {
  from_id: string;
  to_id: string;
  kind: string;
  provenance: string | null;
  at_line: number | null;
  at_column: number | null;
  at_sites: string | null;
}

/**
 * SQLite-backed graph store using Node's built-in {@link DatabaseSync} — no
 * native dependency. Two tables (nodes, edges) mirror the in-memory store; the
 * implicit `rowid` preserves insertion order so query results match the
 * in-memory backend exactly (verified by the shared store contract).
 *
 * Pass a file path to persist across processes, or omit it for an in-memory db.
 */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(location = ":memory:") {
    this.db = new DatabaseSync(location);
    // WAL lets readers run concurrently with a writer (no-op for :memory:).
    // synchronous=NORMAL is the safe, fast pairing with WAL; busy_timeout
    // lets concurrent connections wait out a lock instead of failing.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        name           TEXT NOT NULL,
        file           TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        start_line     INTEGER,
        end_line       INTEGER,
        tier           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nodes_name ON nodes(name);
      CREATE TABLE IF NOT EXISTS edges (
        from_id    TEXT NOT NULL,
        to_id      TEXT NOT NULL,
        kind       TEXT NOT NULL,
        provenance TEXT,
        at_line    INTEGER,
        at_column  INTEGER,
        at_sites   TEXT
      );
      CREATE INDEX IF NOT EXISTS edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id);
      -- (from, to, kind) identifies an edge; the unique index lets INSERT OR
      -- IGNORE collapse the same fact emitted twice into a single row.
      CREATE UNIQUE INDEX IF NOT EXISTS edges_unique ON edges(from_id, to_id, kind);
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(name, id UNINDEXED);
      CREATE TABLE IF NOT EXISTS files (
        path     TEXT PRIMARY KEY,
        size     INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        hash     TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Additive migrations for DBs created before a column existed — each `ADD
    // COLUMN` throws if present, so guard each independently (ama-m8k.1, ama-hft.9).
    for (const ddl of [
      "ALTER TABLE edges ADD COLUMN provenance TEXT",
      "ALTER TABLE edges ADD COLUMN at_line INTEGER",
      "ALTER TABLE edges ADD COLUMN at_column INTEGER",
      "ALTER TABLE edges ADD COLUMN at_sites TEXT",
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        // Column already present — nothing to do.
      }
    }
  }

  addNode(node: GraphNode): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO nodes
           (id, kind, name, file, qualified_name, start_line, end_line, tier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        node.kind,
        node.name,
        node.file,
        node.qualifiedName,
        node.range?.startLine ?? null,
        node.range?.endLine ?? null,
        node.tier,
      );
    // Keep the FTS row idempotent too: re-adding an id (a re-indexed file) must
    // not leave a stale duplicate behind, since fts5 has no INSERT OR REPLACE.
    this.db.prepare("DELETE FROM nodes_fts WHERE id = ?").run(node.id);
    this.db.prepare("INSERT INTO nodes_fts (name, id) VALUES (?, ?)").run(node.name, node.id);
  }

  addEdge(edge: GraphEdge): void {
    // OR IGNORE drops a duplicate (from, to, kind) via the edges_unique index.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO edges (from_id, to_id, kind, provenance, at_line, at_column, at_sites)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        edge.from,
        edge.to,
        edge.kind,
        edge.provenance ?? null,
        edge.at?.line ?? null,
        edge.at?.column ?? null,
        edge.sites ? JSON.stringify(edge.sites) : null,
      );
  }

  getNode(id: string): GraphNode | undefined {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
    return row ? rowToNode(row as unknown as NodeRow) : undefined;
  }

  nodesByName(name: string): GraphNode[] {
    return this.db
      .prepare("SELECT * FROM nodes WHERE name = ? ORDER BY rowid")
      .all(name)
      .map((r) => rowToNode(r as unknown as NodeRow));
  }

  searchByName(query: string, limit = 50): GraphNode[] {
    // FTS5 query syntax is permissive; restrict to identifier chars and run a
    // prefix match. Names are single tokens, so this matches by leading prefix.
    const term = query.replace(/[^A-Za-z0-9_]/g, " ").trim();
    if (!term) return [];
    const seen = new Set<string>();
    const out: GraphNode[] = [];
    const collect = (rows: Array<{ id: string }>): void => {
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const node = this.getNode(row.id);
        if (node) out.push(node);
      }
    };
    // FTS5 prefix match on the (single-token) name — fast and ranked.
    collect(
      this.db
        .prepare("SELECT id FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY rank LIMIT ?")
        .all(`${term}*`, limit) as Array<{ id: string }>,
    );
    // Substring match on the qualified name, so a dotted ref ("Cls.method") and
    // a container name resolve too — the FTS index only holds the simple name.
    if (out.length < limit) {
      collect(
        this.db
          .prepare("SELECT id FROM nodes WHERE lower(qualified_name) LIKE ? LIMIT ?")
          .all(`%${query.toLowerCase()}%`, limit) as Array<{ id: string }>,
      );
    }
    return out.slice(0, limit);
  }

  edgesFrom(id: string, kind?: EdgeKind): GraphEdge[] {
    const rows = kind
      ? this.db
          .prepare("SELECT * FROM edges WHERE from_id = ? AND kind = ? ORDER BY rowid")
          .all(id, kind)
      : this.db.prepare("SELECT * FROM edges WHERE from_id = ? ORDER BY rowid").all(id);
    return rows.map((r) => rowToEdge(r as unknown as EdgeRow));
  }

  edgesTo(id: string, kind?: EdgeKind): GraphEdge[] {
    const rows = kind
      ? this.db
          .prepare("SELECT * FROM edges WHERE to_id = ? AND kind = ? ORDER BY rowid")
          .all(id, kind)
      : this.db.prepare("SELECT * FROM edges WHERE to_id = ? ORDER BY rowid").all(id);
    return rows.map((r) => rowToEdge(r as unknown as EdgeRow));
  }

  *allNodes(): IterableIterator<GraphNode> {
    for (const row of this.db.prepare("SELECT * FROM nodes ORDER BY rowid").all()) {
      yield rowToNode(row as unknown as NodeRow);
    }
  }

  get nodeCount(): number {
    return count(this.db, "nodes");
  }

  get edgeCount(): number {
    return count(this.db, "edges");
  }

  recordFile(meta: FileMeta): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files (path, size, mtime_ms, hash)
         VALUES (?, ?, ?, ?)`,
      )
      .run(meta.path, meta.size, meta.mtimeMs, meta.hash);
  }

  getFile(path: string): FileMeta | undefined {
    const row = this.db.prepare("SELECT * FROM files WHERE path = ?").get(path);
    return row ? rowToFile(row as unknown as FileRow) : undefined;
  }

  allFiles(): FileMeta[] {
    return this.db
      .prepare("SELECT * FROM files ORDER BY rowid")
      .all()
      .map((r) => rowToFile(r as unknown as FileRow));
  }

  removeFile(path: string): void {
    // Order matters: the edge/fts deletes reference the file's nodes, so they
    // must run before the nodes themselves are gone. Edges arriving from other
    // files (to_id in this file) are deliberately left in place.
    const owned = "(SELECT id FROM nodes WHERE file = ?)";
    this.db.prepare(`DELETE FROM edges WHERE from_id IN ${owned}`).run(path);
    this.db.prepare(`DELETE FROM nodes_fts WHERE id IN ${owned}`).run(path);
    this.db.prepare("DELETE FROM nodes WHERE file = ?").run(path);
    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
  }

  reconcileFile(path: string, nodes: GraphNode[], edges: GraphEdge[]): void {
    const newIds = new Set(nodes.map((n) => n.id));
    const oldIds = (
      this.db.prepare("SELECT id FROM nodes WHERE file = ?").all(path) as Array<{ id: string }>
    ).map((r) => r.id);
    // 1. Drop symbols that disappeared (and the edges leaving them).
    const delEdgesFrom = this.db.prepare("DELETE FROM edges WHERE from_id = ?");
    const delFts = this.db.prepare("DELETE FROM nodes_fts WHERE id = ?");
    const delNode = this.db.prepare("DELETE FROM nodes WHERE id = ?");
    for (const id of oldIds) {
      if (newIds.has(id)) continue;
      delEdgesFrom.run(id);
      delFts.run(id);
      delNode.run(id);
    }
    // 2. Upsert the file's current nodes (addNode is idempotent).
    for (const n of nodes) this.addNode(n);
    // 3. Reconcile the edges the file owns to exactly `edges`: delete the ones
    //    no longer emitted, then add the rest (INSERT OR IGNORE dedupes).
    const fresh = new Set(edges.map(edgeKey));
    const owned = this.db
      .prepare(
        "SELECT from_id, to_id, kind FROM edges WHERE from_id IN (SELECT id FROM nodes WHERE file = ?)",
      )
      .all(path) as unknown as EdgeRow[];
    const delEdge = this.db.prepare(
      "DELETE FROM edges WHERE from_id = ? AND to_id = ? AND kind = ?",
    );
    for (const e of owned) {
      if (!fresh.has(edgeKey(rowToEdge(e)))) delEdge.run(e.from_id, e.to_id, e.kind);
    }
    for (const e of edges) this.addEdge(e);
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? (row as { value: string }).value : undefined;
  }

  clear(): void {
    // Wipe data but keep the schema, so a re-index into a persistent file starts
    // clean without dropping/recreating tables.
    this.db.exec(
      "DELETE FROM edges; DELETE FROM nodes_fts; DELETE FROM nodes; DELETE FROM files; DELETE FROM meta;",
    );
  }

  /** Close the underlying database. Required for file-backed stores. */
  close(): void {
    this.db.close();
  }
}

function rowToNode(r: NodeRow): GraphNode {
  const node: GraphNode = {
    id: r.id,
    kind: r.kind as NodeKind,
    name: r.name,
    file: r.file,
    qualifiedName: r.qualified_name,
    tier: r.tier as Tier,
  };
  if (r.start_line !== null && r.end_line !== null) {
    node.range = { startLine: r.start_line, endLine: r.end_line };
  }
  return node;
}

function rowToEdge(r: EdgeRow): GraphEdge {
  const edge: GraphEdge = { from: r.from_id, to: r.to_id, kind: r.kind as EdgeKind };
  if (r.provenance) edge.provenance = r.provenance as EdgeProvenance;
  if (r.at_line !== null && r.at_column !== null) {
    edge.at = { line: r.at_line, column: r.at_column };
  }
  if (r.at_sites) edge.sites = JSON.parse(r.at_sites) as GraphEdge["sites"];
  return edge;
}

/** Canonical identity of an edge: its (from, to, kind) triple, as printable JSON. */
function edgeKey(e: GraphEdge): string {
  return JSON.stringify([e.from, e.to, e.kind]);
}

function rowToFile(r: FileRow): FileMeta {
  return {
    path: r.path,
    size: Number(r.size),
    mtimeMs: Number(r.mtime_ms),
    hash: r.hash,
  };
}

function count(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as {
    c: number | bigint;
  };
  return Number(row.c);
}
