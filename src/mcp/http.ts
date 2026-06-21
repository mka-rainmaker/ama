import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createDefaultIndexer } from "../indexer/indexer.js";
import { ensureBaselineWasmTier } from "../runtime/wasm-tier.js";
import { InMemoryStore } from "../store/memory.js";
import { SqliteStore } from "../store/sqlite.js";
import type { Store } from "../store/types.js";
import { createServer as createMcpServer } from "./server.js";
import { AmaSession } from "./session.js";

const MCP_PATH = "/mcp";

/**
 * A standalone Node HTTP server that serves Ama's MCP tools over the Streamable
 * HTTP transport — the same tools as the stdio server, reachable by URL.
 *
 * One {@link AmaSession} (the index) is shared across every client session, so
 * it outlives a client disconnect/reconnect within this process. That decouples
 * the index's lifetime from the client connection: a `tsx watch` restart of the
 * *process* is the only thing that drops it, and connect-time catch-up (plus a
 * future persistent store) makes that cheap. Each MCP session gets its own
 * transport + {@link createMcpServer} wrapper over the shared session.
 */
export function createHttpServer(session: AmaSession = new AmaSession()): http.Server {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  return http.createServer((req, res) => void handle(req, res));

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      if (pathname !== MCP_PATH) {
        res.writeHead(404).end();
        return;
      }
      const header = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(header) ? header[0] : header;

      if (req.method === "POST") {
        const body = await readJson(req);
        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          if (!isInitializeRequest(body)) {
            // The session id is unknown (e.g. wiped by a `tsx watch` restart).
            // Per the Streamable HTTP spec a 404 tells the client to drop the
            // dead session and re-initialize — the hook for auto-reconnect.
            res.writeHead(404, { "content-type": "application/json" }).end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32001, message: "Session not found — reinitialize." },
                id: null,
              }),
            );
            return;
          }
          transport = newSession(session, transports);
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      // GET (server SSE stream) and DELETE (session teardown) need an existing session.
      if (req.method === "GET" || req.method === "DELETE") {
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          // 404 (not 400) so a client whose session was wiped re-initializes.
          res.writeHead(404).end();
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }
      res.writeHead(405).end();
    } catch (err) {
      console.error("[ama] HTTP request failed:", err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }
}

/** Spin up a transport + MCP server for a new client session over `session`. */
function newSession(
  session: AmaSession,
  transports: Map<string, StreamableHTTPServerTransport>,
): StreamableHTTPServerTransport {
  // Annotated so the callbacks can reference `transport` within its own
  // initializer; block bodies so they return void, not the Map.
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      transports.set(id, transport);
    },
    onsessionclosed: (id) => {
      transports.delete(id);
    },
  });
  void createMcpServer(session).connect(transport);
  return transport;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/** Entry point: serve MCP over Streamable HTTP. Logs to stderr (stdout is free
 * here, unlike stdio, but stderr keeps logging uniform across transports). */
export async function main(): Promise<void> {
  const port = Number(process.env.AMA_HTTP_PORT ?? 7077);
  // With AMA_DB set, persist to (and reopen from) a file-backed store; with
  // AMA_ROOT too, reopen that project's index at startup so a restart skips the
  // full re-index and connect-time catch-up reconciles any drift.
  const dbPath = process.env.AMA_DB;
  const root = process.env.AMA_ROOT;
  // Persist exactly one project to AMA_DB — the configured AMA_ROOT, or the first one
  // indexed — and give every *other* project its own in-memory store, so a multi-project
  // session never aliases several projects onto one shared db. (ama-mnj)
  let createStore: ((projectRoot: string) => Store) | undefined;
  if (dbPath) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = dbPath;
    let persisted = root ? path.resolve(root) : undefined;
    createStore = (projectRoot) => {
      persisted ??= projectRoot; // the first project indexed claims the persistent db
      return projectRoot === persisted ? new SqliteStore(db) : new InMemoryStore();
    };
  }
  const session = createStore
    ? new AmaSession(createDefaultIndexer(createStore))
    : new AmaSession();
  if (dbPath && root) {
    const stats = await session.open(root);
    console.error(
      `ama: index ready — ${stats.nodeCount} nodes / ${stats.fileCount} files (${root})`,
    );
  }
  const server = createHttpServer(session);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.error(`ama MCP server (HTTP) on http://localhost:${port}${MCP_PATH}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Pin grammar WASM to the baseline compiler before anything loads it, or the
  // long-running index OOMs (ama-rgx). Re-execs once; the supervisor skips main.
  if (!ensureBaselineWasmTier()) {
    main().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
}
