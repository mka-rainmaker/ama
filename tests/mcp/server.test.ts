import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/mcp/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../fixtures/mini-repo");

async function connectClient(): Promise<Client> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function firstText(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

describe("MCP server", () => {
  it("advertises the index tools", async () => {
    const client = await connectClient();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("index_repository");
    expect(names).toContain("index_status");
  });

  it("indexes a repository and reports status over the protocol", async () => {
    const client = await connectClient();
    await client.callTool({
      name: "index_repository",
      arguments: { path: root },
    });
    const status = JSON.parse(
      firstText(await client.callTool({ name: "index_status", arguments: {} })),
    );
    expect(status.indexed).toBe(true);
    expect(status.fileCount).toBe(2);
    expect(status.pendingSync).toBe(0);
    expect(status.languages[0]).toMatchObject({
      language: "typescript",
      tier: "deep",
    });
    // Resolution coverage travels too (ama-m8k.12) — an honest "how much of the
    // call graph resolved" signal, internally consistent (resolved <= total).
    expect(status.resolution.callsTotal).toBeGreaterThan(0);
    expect(status.resolution.callsResolved).toBeLessThanOrEqual(status.resolution.callsTotal);
    // The build stamp travels over the protocol so a client can check freshness.
    expect(typeof status.server.version).toBe("string");
    expect(status.server).toHaveProperty("revision");
  });

  it("sync_index reconciles a file changed on disk after indexing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-mcp-sync-"));
    try {
      fs.writeFileSync(path.join(dir, "m.ts"), "export function before(): void {}\n");
      const client = await connectClient();
      await client.callTool({ name: "index_repository", arguments: { path: dir } });

      fs.writeFileSync(
        path.join(dir, "m.ts"),
        "export function before(): void {}\nexport function afterSync(): void {}\n",
      );
      const result = JSON.parse(
        firstText(await client.callTool({ name: "sync_index", arguments: {} })),
      );
      expect(result.changed).toContain("m.ts");

      const hits = JSON.parse(
        firstText(
          await client.callTool({ name: "search_symbol", arguments: { query: "afterSync" } }),
        ),
      );
      expect(hits.map((n: { name: string }) => n.name)).toContain("afterSync");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const callsRoot = path.resolve(here, "../fixtures/ts-calls");

describe("MCP query tools", () => {
  async function indexedClient(): Promise<Client> {
    const client = await connectClient();
    await client.callTool({
      name: "index_repository",
      arguments: { path: callsRoot },
    });
    return client;
  }

  it("search_symbol finds symbols by name", async () => {
    const client = await indexedClient();
    const hits = JSON.parse(
      firstText(
        await client.callTool({
          name: "search_symbol",
          arguments: { query: "helper" },
        }),
      ),
    );
    expect(hits.map((n: { name: string }) => n.name)).toContain("helper");
  });

  it("search_symbol appends a low-confidence hint for a loose substring match (ama-b79)", async () => {
    const client = await indexedClient();
    const result = (await client.callTool({
      name: "search_symbol",
      arguments: { query: "ervic" }, // substring of "Service", no exact/prefix hit
    })) as { content: Array<{ type: string; text: string }> };
    // The first block is still the JSON array (backward compatible)...
    const hits = JSON.parse(result.content[0]?.text ?? "[]");
    expect(hits.map((n: { name: string }) => n.name)).toContain("Service");
    // ...and a second block carries the refine-the-query hint.
    expect(result.content).toHaveLength(2);
    expect(result.content[1]?.text).toContain("substring");
  });

  it("search_symbol stays a single block for a strong (exact) match", async () => {
    const client = await indexedClient();
    const result = (await client.callTool({
      name: "search_symbol",
      arguments: { query: "helper" },
    })) as { content: Array<{ type: string; text: string }> };
    expect(result.content).toHaveLength(1);
  });

  it("search_symbol filters by node kind", async () => {
    const client = await indexedClient();
    const asClass = JSON.parse(
      firstText(
        await client.callTool({
          name: "search_symbol",
          arguments: { query: "Service", kind: "Class" },
        }),
      ),
    );
    expect(asClass.map((n: { name: string }) => n.name)).toEqual(["Service"]);
    // Same query, kind:Method → the members qualified under "Service"
    // (qualified-name matching surfaces a container's methods), not the class.
    const asMethod = JSON.parse(
      firstText(
        await client.callTool({
          name: "search_symbol",
          arguments: { query: "Service", kind: "Method" },
        }),
      ),
    );
    expect(asMethod.map((n: { name: string }) => n.name).sort()).toEqual(["compute", "run"]);
  });

  it("find_callers lists every caller of a symbol", async () => {
    const client = await indexedClient();
    const callers = JSON.parse(
      firstText(
        await client.callTool({
          name: "find_callers",
          arguments: { symbol: "helper" },
        }),
      ),
    );
    const names = callers
      .map((n: { symbol: { qualifiedName: string } }) => n.symbol.qualifiedName)
      .sort();
    expect(names).toEqual(["Service.compute", "main"]);
  });

  it("find_callees lists what a symbol calls", async () => {
    const client = await indexedClient();
    const callees = JSON.parse(
      firstText(
        await client.callTool({
          name: "find_callees",
          arguments: { symbol: "main" },
        }),
      ),
    );
    expect(callees.map((n: { symbol: { name: string } }) => n.symbol.name)).toContain("helper");
  });

  it("get_code_snippet returns verbatim source", async () => {
    const client = await indexedClient();
    const snip = JSON.parse(
      firstText(
        await client.callTool({
          name: "get_code_snippet",
          arguments: { symbol: "helper" },
        }),
      ),
    );
    expect(snip.text).toContain("return 42;");
  });

  it("returns a clean null result (not a protocol error) for an unresolved symbol", async () => {
    const client = await indexedClient();
    // get_code_snippet and node return undefined for an unknown ref; the tool
    // result must still be valid MCP content, not a JSON.stringify(undefined) crash.
    const snip = await client.callTool({
      name: "get_code_snippet",
      arguments: { symbol: "doesNotExist" },
    });
    expect(JSON.parse(firstText(snip))).toBeNull();
    const node = await client.callTool({ name: "node", arguments: { ref: "doesNotExist" } });
    expect(JSON.parse(firstText(node))).toBeNull();
  });

  it("node assembles a symbol's definition, source, callers, and callees", async () => {
    const client = await indexedClient();
    const view = JSON.parse(
      firstText(await client.callTool({ name: "node", arguments: { ref: "helper" } })),
    );
    expect(view.node.name).toBe("helper");
    expect(view.snippet.text).toContain("return 42;");
    const callers = view.callers.map((n: { qualifiedName: string }) => n.qualifiedName).sort();
    expect(callers).toEqual(["Service.compute", "main"]);
  });

  it("file_skeleton returns a file's symbol outline and dependents", async () => {
    const client = await indexedClient();
    const skel = JSON.parse(
      firstText(await client.callTool({ name: "file_skeleton", arguments: { file: "calls.ts" } })),
    );
    expect(skel.file.kind).toBe("File");
    const names = skel.symbols.map((n: { name: string }) => n.name);
    expect(names).toContain("helper");
    expect(names).toContain("Service");
    // Outline is in source order: helper (line 1) precedes Service (line 9).
    expect(names.indexOf("helper")).toBeLessThan(names.indexOf("Service"));
    // The File node itself is not listed among its own symbols.
    expect(names).not.toContain("calls.ts");
    // Nothing imports this single-file fixture.
    expect(skel.dependents).toEqual([]);
  });

  it("impact_analysis returns the transitive blast radius of a symbol", async () => {
    const client = await indexedClient();
    const affected = JSON.parse(
      firstText(
        await client.callTool({ name: "impact_analysis", arguments: { symbol: "helper" } }),
      ),
    );
    const names = affected.map((n: { qualifiedName: string }) => n.qualifiedName).sort();
    // Service.run is reached only transitively (run -> compute -> helper).
    expect(names).toEqual(["Service.compute", "Service.run", "main"]);
  });

  it("get_graph_schema reports node and edge kind counts", async () => {
    const client = await indexedClient();
    const schema = JSON.parse(
      firstText(await client.callTool({ name: "get_graph_schema", arguments: {} })),
    );
    expect(schema.nodes.Function).toBe(2);
    expect(schema.nodes.Class).toBe(1);
    expect(schema.edges.Calls).toBe(3);
  });

  it("search_code finds symbols by what's inside their body", async () => {
    const client = await indexedClient();
    const hits = JSON.parse(
      firstText(await client.callTool({ name: "search_code", arguments: { query: "return 42" } })),
    );
    expect(hits.map((n: { qualifiedName: string }) => n.qualifiedName)).toEqual(["helper"]);
  });

  it("explore returns matches by file, relationships, and blast radius", async () => {
    const client = await indexedClient();
    const ex = JSON.parse(
      firstText(await client.callTool({ name: "explore", arguments: { question: "compute" } })),
    );
    expect(ex.byFile["calls.ts"].map((n: { qualifiedName: string }) => n.qualifiedName)).toEqual([
      "Service.compute",
    ]);
    expect(ex.blastRadius.map((n: { qualifiedName: string }) => n.qualifiedName)).toEqual([
      "Service.run",
    ]);
  });
});

const expressRoot = path.resolve(here, "../fixtures/ts-express");

describe("MCP route tools", () => {
  async function indexedClient(): Promise<Client> {
    const client = await connectClient();
    await client.callTool({ name: "index_repository", arguments: { path: expressRoot } });
    return client;
  }

  it("find_handlers returns the handler a route references", async () => {
    const client = await indexedClient();
    const handlers = JSON.parse(
      firstText(
        await client.callTool({ name: "find_handlers", arguments: { route: "GET /users" } }),
      ),
    );
    expect(handlers.map((n: { symbol: { name: string } }) => n.symbol.name)).toContain("listUsers");
  });

  it("find_routes returns the routes that reference a handler", async () => {
    const client = await indexedClient();
    const routes = JSON.parse(
      firstText(await client.callTool({ name: "find_routes", arguments: { symbol: "listUsers" } })),
    );
    expect(routes.map((n: { symbol: { name: string } }) => n.symbol.name)).toContain("GET /users");
  });

  it("find_referrers returns everything that references a symbol", async () => {
    const client = await indexedClient();
    const referrers = JSON.parse(
      firstText(
        await client.callTool({ name: "find_referrers", arguments: { symbol: "listUsers" } }),
      ),
    );
    expect(referrers.map((n: { symbol: { name: string } }) => n.symbol.name)).toContain(
      "GET /users",
    );
  });
});

const cycleRoot = path.resolve(here, "../fixtures/ts-cycle");

describe("MCP analysis tools", () => {
  it("circular_imports reports a file-level import cycle", async () => {
    const client = await connectClient();
    await client.callTool({ name: "index_repository", arguments: { path: cycleRoot } });
    const cycles = JSON.parse(
      firstText(await client.callTool({ name: "circular_imports", arguments: {} })),
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0].map((n: { file: string }) => n.file).sort()).toEqual(["a.ts", "b.ts"]);
  });
});

const implementsRoot = path.resolve(here, "../fixtures/ts-implements");

describe("MCP override tools", () => {
  it("find_overrides returns the interface method a class method overrides", async () => {
    const client = await connectClient();
    await client.callTool({ name: "index_repository", arguments: { path: implementsRoot } });
    const overrides = JSON.parse(
      firstText(
        await client.callTool({
          name: "find_overrides",
          arguments: { symbol: "FriendlyGreeter.greet" },
        }),
      ),
    );
    expect(
      overrides.map((n: { symbol: { qualifiedName: string } }) => n.symbol.qualifiedName),
    ).toContain("Greeter.greet");
  });
});

describe("MCP tool-call logging", () => {
  const realEnv = process.env.AMA_LOG_TOOLS;
  afterEach(() => {
    // Reflect.deleteProperty (not `delete`) truly removes the var — assigning
    // `undefined` would stringify to "undefined" (truthy) in process.env.
    if (realEnv === undefined) Reflect.deleteProperty(process.env, "AMA_LOG_TOOLS");
    else process.env.AMA_LOG_TOOLS = realEnv;
    vi.restoreAllMocks();
  });

  it("prints one stderr line per tool call (name + reply summary) when AMA_LOG_TOOLS is set", async () => {
    process.env.AMA_LOG_TOOLS = "1";
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });

    const client = await connectClient();
    await client.callTool({ name: "index_repository", arguments: { path: callsRoot } });
    await client.callTool({ name: "find_callers", arguments: { symbol: "helper" } });

    // index_repository reports its counts; find_callers reports a result count.
    expect(lines.some((l) => l.includes("[ama] index_repository") && l.includes("nodes"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("[ama] find_callers") && l.includes("2 results"))).toBe(
      true,
    );
  });

  it("stays silent when AMA_LOG_TOOLS is unset", async () => {
    Reflect.deleteProperty(process.env, "AMA_LOG_TOOLS");
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });

    const client = await connectClient();
    await client.callTool({ name: "index_repository", arguments: { path: callsRoot } });
    await client.callTool({ name: "find_callers", arguments: { symbol: "helper" } });

    expect(lines.some((l) => l.includes("[ama]"))).toBe(false);
  });
});

const implRoot = path.resolve(here, "../fixtures/ts-implements");

describe("MCP implements tools", () => {
  async function indexedClient(): Promise<Client> {
    const client = await connectClient();
    await client.callTool({
      name: "index_repository",
      arguments: { path: implRoot },
    });
    return client;
  }

  it("find_implementations lists every class implementing an interface", async () => {
    const client = await indexedClient();
    const impls = JSON.parse(
      firstText(
        await client.callTool({
          name: "find_implementations",
          arguments: { symbol: "Greeter" },
        }),
      ),
    );
    const names = impls.map((n: { qualifiedName: string }) => n.qualifiedName).sort();
    expect(names).toEqual(["FriendlyGreeter", "Person"]);
  });

  it("find_interfaces lists the interfaces a class implements", async () => {
    const client = await indexedClient();
    const ifaces = JSON.parse(
      firstText(
        await client.callTool({
          name: "find_interfaces",
          arguments: { symbol: "Person" },
        }),
      ),
    );
    const names = ifaces.map((n: { qualifiedName: string }) => n.qualifiedName).sort();
    expect(names).toEqual(["Greeter", "Named"]);
  });
});

const importsRoot = path.resolve(here, "../fixtures/ts-imports");

describe("MCP imports tools", () => {
  async function indexedClient(): Promise<Client> {
    const client = await connectClient();
    await client.callTool({
      name: "index_repository",
      arguments: { path: importsRoot },
    });
    return client;
  }

  it("affected lists the files impacted by changing a file", async () => {
    const client = await indexedClient();
    const files = JSON.parse(
      firstText(await client.callTool({ name: "affected", arguments: { files: ["lib.ts"] } })),
    );
    const names = files.map((n: { name: string }) => n.name).sort();
    // Everything that imports from lib (incl. the star/namespace barrels).
    expect(names).toContain("main.ts");
    expect(names).toContain("barrel.ts");
  });

  it("find_imports lists the symbols a file imports", async () => {
    const client = await indexedClient();
    const imports = JSON.parse(
      firstText(
        await client.callTool({
          name: "find_imports",
          arguments: { file: "main.ts" },
        }),
      ),
    );
    const names = imports.map((n: { name: string }) => n.name).sort();
    // `lib.ts` is the File node — main.ts's `import * as lib` targets the whole module.
    expect(names).toEqual(["Widget", "greet", "lib.ts", "makeDefault"]);
  });

  it("find_importers lists every file importing a symbol, including via re-export", async () => {
    const client = await indexedClient();
    const importers = JSON.parse(
      firstText(
        await client.callTool({
          name: "find_importers",
          arguments: { symbol: "greet" },
        }),
      ),
    );
    const names = importers.map((n: { name: string }) => n.name).sort();
    expect(names).toEqual(["barrel.ts", "main.ts"]);
  });
});

const usesTypeRoot = path.resolve(here, "../fixtures/ts-usestype");

describe("MCP UsesType tools", () => {
  async function indexedClient(): Promise<Client> {
    const client = await connectClient();
    await client.callTool({
      name: "index_repository",
      arguments: { path: usesTypeRoot },
    });
    return client;
  }

  it("find_type_users lists every symbol that uses a type", async () => {
    const client = await indexedClient();
    const users = JSON.parse(
      firstText(
        await client.callTool({
          name: "find_type_users",
          arguments: { type: "Widget" },
        }),
      ),
    );
    const names = users.map((n: { qualifiedName: string }) => n.qualifiedName).sort();
    expect(names).toEqual(["Factory.make", "Holder.item", "build", "many"]);
  });

  it("find_types_used lists the types a symbol uses", async () => {
    const client = await indexedClient();
    const types = JSON.parse(
      firstText(
        await client.callTool({
          name: "find_types_used",
          arguments: { symbol: "build" },
        }),
      ),
    );
    const names = types.map((n: { name: string }) => n.name).sort();
    expect(names).toEqual(["Gadget", "Widget"]);
  });
});
