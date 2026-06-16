import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
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
    const names = callers.map((n: { qualifiedName: string }) => n.qualifiedName).sort();
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
    expect(callees.map((n: { name: string }) => n.name)).toContain("helper");
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
    expect(names).toEqual(["Factory.make", "Holder", "build", "many"]);
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
