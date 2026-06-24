import { describe, expect, it } from "vitest";
import { ENV_REF_PREFIX, deriveEnvReferences } from "../../src/graph/env-link.js";
import type { GraphEdge, GraphNode } from "../../src/graph/index.js";
import { fileId, symbolId } from "../../src/graph/index.js";

function node(
  over: Partial<GraphNode> & { id: string; kind: GraphNode["kind"]; file: string },
): GraphNode {
  return { name: over.id, qualifiedName: over.id, tier: "baseline", ...over };
}

describe("deriveEnvReferences — .env variable resolution", () => {
  const apiUrlVarId = symbolId({ file: "config/.env", qualifiedName: "API_URL" });
  const codeFileId = fileId("src/app.ts");
  const codeNodeId = symbolId({ file: "src/app.ts", qualifiedName: "getConfig" });

  function baseNodes(): GraphNode[] {
    return [
      node({
        id: fileId("config/.env"),
        kind: "File",
        file: "config/.env",
        name: ".env",
        qualifiedName: "",
      }),
      node({
        id: apiUrlVarId,
        kind: "Variable",
        file: "config/.env",
        name: "API_URL",
        qualifiedName: "API_URL",
      }),
      node({
        id: codeFileId,
        kind: "File",
        file: "src/app.ts",
        name: "app.ts",
        qualifiedName: "",
      }),
      node({
        id: codeNodeId,
        kind: "Function",
        file: "src/app.ts",
        name: "getConfig",
        qualifiedName: "getConfig",
      }),
    ];
  }

  it("resolves env: candidate to a Variable node in a .env file", () => {
    const edges: GraphEdge[] = [
      {
        from: codeNodeId,
        to: `${ENV_REF_PREFIX}API_URL`,
        kind: "References",
        provenance: "env-ref",
      },
    ];
    const resolved = deriveEnvReferences(baseNodes(), edges);
    expect(resolved).toContainEqual({
      from: codeNodeId,
      to: apiUrlVarId,
      kind: "References",
      provenance: "env",
    });
  });

  it("ignores env: candidates with no matching Variable", () => {
    const edges: GraphEdge[] = [
      {
        from: codeNodeId,
        to: `${ENV_REF_PREFIX}NOPE`,
        kind: "References",
        provenance: "env-ref",
      },
    ];
    const resolved = deriveEnvReferences(baseNodes(), edges);
    expect(resolved).toEqual([]);
  });

  it("ignores edges with provenance other than env-ref", () => {
    const edges: GraphEdge[] = [
      {
        from: codeNodeId,
        to: `${ENV_REF_PREFIX}API_URL`,
        kind: "References",
        provenance: "resolved",
      },
    ];
    const resolved = deriveEnvReferences(baseNodes(), edges);
    expect(resolved).toEqual([]);
  });

  it("ignores self-references (from === to)", () => {
    const edges: GraphEdge[] = [
      {
        from: apiUrlVarId,
        to: `${ENV_REF_PREFIX}API_URL`,
        kind: "References",
        provenance: "env-ref",
      },
    ];
    const resolved = deriveEnvReferences(baseNodes(), edges);
    expect(resolved).toEqual([]);
  });
});
