import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DotenvAnalyzer } from "../../../src/analyzers/dotenv/analyzer.js";
import { AnalyzerRegistry } from "../../../src/analyzers/registry.js";
import { fileId, symbolId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/dotenv");
// A committed, non-gitignored env file (a real `.env` is gitignored, so the indexer skips it; the
// committed reference file — `.env.example` / `sample.env` — is what gets analyzed in practice).
const FIXTURE = "sample.env";

describe("DotenvAnalyzer", () => {
  it("emits a File node and a Variable value-origin node per KEY=value line", () => {
    const result = new DotenvAnalyzer().analyze(root, [FIXTURE]);
    expect(result.nodes.length).toBe(3);

    const fileNode = result.nodes.find((n) => n.kind === "File");
    expect(fileNode?.id).toBe(fileId(FIXTURE));

    const apiUrl = result.nodes.find((n) => n.kind === "Variable" && n.name === "API_URL");
    expect(apiUrl?.qualifiedName).toBe("API_URL");
    expect(apiUrl?.file).toBe(FIXTURE);
    expect(apiUrl?.range?.startLine).toBe(1);
    expect(apiUrl?.tier).toBe("baseline");

    expect(result.edges).toContainEqual({
      from: fileId(FIXTURE),
      to: symbolId({ file: FIXTURE, qualifiedName: "API_URL" }),
      kind: "Defines",
    });
  });

  it("skips blank lines and comments", () => {
    const result = new DotenvAnalyzer().analyze(root, [FIXTURE]);
    const variables = result.nodes.filter((n) => n.kind === "Variable");
    expect(variables.map((v) => v.name).sort()).toEqual(["API_URL", "MAX_RETRIES"]);
  });

  it("claims the whole env-file family (incl. .env.example), not just .env", () => {
    const a = new DotenvAnalyzer();
    expect(a.matchesFile(".env")).toBe(true);
    expect(a.matchesFile("config/.env.example")).toBe(true);
    expect(a.matchesFile(".env.local")).toBe(true);
    expect(a.matchesFile("services/api.env")).toBe(true);
    expect(a.matchesFile("src/main.ts")).toBe(false);
  });

  it("is routed by the registry for `.env.example` (extension is `.example`, so matchesFile claims it)", () => {
    const registry = new AnalyzerRegistry();
    registry.register(new DotenvAnalyzer());
    expect(registry.forFile("project/.env.example")?.language).toBe("dotenv");
    expect(registry.forFile("project/config.env")?.language).toBe("dotenv");
    expect(registry.forFile("project/main.ts")).toBeUndefined();
  });
});
