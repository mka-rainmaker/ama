import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
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
            res.writeHead(400).end(JSON.stringify({ error: "No active MCP session" }));
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
          res.writeHead(400).end();
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
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.error(`ama MCP server (HTTP) on http://localhost:${port}${MCP_PATH}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
