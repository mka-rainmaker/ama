import { DatabaseSync } from "node:sqlite";
import type { EdgeKind, GraphEdge, GraphNode, NodeKind, Tier } from "../graph/index.js";
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
        from_id TEXT NOT NULL,
        to_id   TEXT NOT NULL,
        kind    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id);
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
    this.db.prepare("INSERT INTO nodes_fts (name, id) VALUES (?, ?)").run(node.name, node.id);
  }

  addEdge(edge: GraphEdge): void {
    this.db
      .prepare("INSERT INTO edges (from_id, to_id, kind) VALUES (?, ?, ?)")
      .run(edge.from, edge.to, edge.kind);
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
    const rows = this.db
      .prepare("SELECT id FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY rank LIMIT ?")
      .all(`${term}*`, limit) as Array<{ id: string }>;
    const seen = new Set<string>();
    const out: GraphNode[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const node = this.getNode(row.id);
      if (node) out.push(node);
    }
    return out;
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

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? (row as { value: string }).value : undefined;
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
  return { from: r.from_id, to: r.to_id, kind: r.kind as EdgeKind };
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
