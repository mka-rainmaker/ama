import { describe, expect, it } from "vitest";
import {
  type AnalyzeResult,
  frame,
  parseMessage,
  parseRequest,
} from "../../../src/analyzers/sidecar/protocol.js";
import type { GraphEdge, GraphNode } from "../../../src/graph/index.js";

/**
 * The sidecar protocol contract: NDJSON-framed messages that validate on the way in, so
 * an out-of-process deep analyzer can hand Ama graph nodes/edges without a buggy sidecar
 * corrupting the graph. (ama-3bb.1)
 */
describe("sidecar protocol (ama-3bb.1)", () => {
  it("round-trips an analyze request through the NDJSON framing", () => {
    const req = { type: "analyze" as const, id: 1, root: "/abs/root", files: ["a.cs", "b.cs"] };
    const line = frame(req);
    expect(line.endsWith("\n")).toBe(true); // one message per line
    expect(parseRequest(line)).toEqual(req);
  });

  it("round-trips a result carrying real graph nodes and edges", () => {
    // Typed literals: if GraphNode/GraphEdge grow a required field, these stop compiling,
    // flagging that the wire schema must follow.
    const node: GraphNode = {
      id: "a.cs#Foo",
      kind: "Class",
      name: "Foo",
      file: "a.cs",
      qualifiedName: "Foo",
      range: { startLine: 1, endLine: 10 },
      tier: "deep",
      external: true,
    };
    const edge: GraphEdge = {
      from: "a.cs#Foo",
      to: "a.cs#Bar",
      kind: "Calls",
      confidence: 1,
      strategy: "implicit-constructor",
      at: { line: 3, column: 5 },
    };
    const result: AnalyzeResult = { type: "result", id: 1, nodes: [node], edges: [edge] };
    const parsed = parseMessage(frame(result));
    expect(parsed).toEqual(result);
  });

  it("accepts the ready handshake", () => {
    const ready = { type: "ready" as const, language: "csharp", version: "1.0" };
    expect(parseMessage(frame(ready))).toEqual(ready);
  });

  it("rejects a malformed line", () => {
    expect(() => parseMessage("{not json")).toThrow();
  });

  it("rejects a node with an unknown kind, guarding the graph", () => {
    const bad = JSON.stringify({
      type: "result",
      id: 1,
      nodes: [
        { id: "x", kind: "Bogus", name: "x", file: "a.cs", qualifiedName: "x", tier: "deep" },
      ],
      edges: [],
    });
    expect(() => parseMessage(bad)).toThrow();
  });
});
