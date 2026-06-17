import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexCommand } from "../../src/cli/commands/lifecycle.js";
import {
  implementationsCommand,
  importersCommand,
  importsCommand,
  interfacesCommand,
  typeUsersCommand,
  typesUsedCommand,
} from "../../src/cli/commands/query.js";
import { COMMANDS } from "../../src/cli/index.js";
import type { CliCommand } from "../../src/cli/index.js";

const saved = { AMA_DB: process.env.AMA_DB, AMA_ROOT: process.env.AMA_ROOT };
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-cli-rel-"));
  fs.writeFileSync(
    path.join(dir, "greeter.ts"),
    "export interface Greeter {\n  greet(): string;\n}\n" +
      'export class Hello implements Greeter {\n  greet(): string {\n    return "hi";\n  }\n}\n',
  );
  fs.writeFileSync(
    path.join(dir, "widget.ts"),
    "export interface Widget {\n  id: number;\n}\n" +
      "export function useWidget(w: Widget): number {\n  return w.id;\n}\n",
  );
  fs.writeFileSync(
    path.join(dir, "dep.ts"),
    'import { Hello } from "./greeter.js";\nexport function make(): Hello {\n  return new Hello();\n}\n',
  );
  process.env.AMA_DB = path.join(dir, ".ama", "index.db");
  process.env.AMA_ROOT = dir;
  await indexCommand.run([dir], { json: true, write: () => {} });
});

afterAll(() => {
  for (const [key, value] of [
    ["AMA_DB", saved.AMA_DB],
    ["AMA_ROOT", saved.AMA_ROOT],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function names(command: CliCommand, ref: string): Promise<string[]> {
  const lines: string[] = [];
  const code = await command.run([ref], { json: true, write: (line) => lines.push(line) });
  expect(code).toBe(0);
  return (JSON.parse(lines.join("\n")) as { name: string }[]).map((n) => n.name);
}

describe("graph query-verb commands", () => {
  it("implementations lists classes implementing an interface", async () => {
    expect(await names(implementationsCommand, "Greeter")).toContain("Hello");
  });

  it("interfaces lists interfaces a class implements", async () => {
    expect(await names(interfacesCommand, "Hello")).toContain("Greeter");
  });

  it("importers lists files that import a symbol", async () => {
    expect(await names(importersCommand, "Hello")).toContain("dep.ts");
  });

  it("imports lists the symbols a file imports", async () => {
    expect(await names(importsCommand, "dep.ts")).toContain("Hello");
  });

  it("type-users lists symbols using a type", async () => {
    expect(await names(typeUsersCommand, "Widget")).toContain("useWidget");
  });

  it("types-used lists the types a symbol uses", async () => {
    expect(await names(typesUsedCommand, "useWidget")).toContain("Widget");
  });
});

describe("CLI command registration", () => {
  it("registers all six relationship verbs", () => {
    const registered = COMMANDS.map((command) => command.name);
    expect(registered).toEqual(
      expect.arrayContaining([
        "implementations",
        "interfaces",
        "importers",
        "imports",
        "type-users",
        "types-used",
      ]),
    );
  });
});
