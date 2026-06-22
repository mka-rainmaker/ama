import { z } from "zod";
import { EDGE_KINDS, NODE_KINDS } from "../../graph/index.js";

/**
 * Wire protocol for out-of-process deep analyzers ("sidecars"). (ama-3bb.1)
 *
 * A sidecar is a subprocess that does semantic analysis for a language Ama can't
 * analyze deeply in-process (.NET via Roslyn, Java via native tooling) and speaks this
 * protocol back. The contract here is language-agnostic; each sidecar implements its own
 * end in its own runtime.
 *
 * **Transport.** Newline-delimited JSON (NDJSON): one JSON object per line. Ama writes
 * requests to the sidecar's **stdin** and reads messages from its **stdout**. The
 * sidecar's **stderr** is for its own logs only — never protocol — exactly the
 * "stdout is JSON-only" rule Ama's own MCP server follows.
 *
 * **Lifecycle.** On startup a sidecar SHOULD emit a `ready` message announcing the
 * language it serves (so the indexer can route and report it). Ama then sends `analyze`
 * requests; the sidecar replies with a `result` (correlated by the request `id`) or an
 * `error`. Ama closes the sidecar's stdin to request shutdown.
 *
 * **Tier.** Everything a sidecar produces is tier `deep` — that is the whole point of
 * running one instead of the baseline syntactic analyzer.
 */

const tierSchema = z.enum(["deep", "baseline"]);
const provenanceSchema = z.enum(["resolved", "heuristic", "dispatch"]);
const sourceRangeSchema = z.object({ startLine: z.number(), endLine: z.number() });
const siteSchema = z.object({ line: z.number(), column: z.number() });

/** A {@link GraphNode} on the wire. Kept in lockstep with the graph model; the node/edge
 *  round-trip test fails if a required field drifts. */
export const graphNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(NODE_KINDS),
  name: z.string(),
  file: z.string(),
  qualifiedName: z.string(),
  range: sourceRangeSchema.optional(),
  tier: tierSchema,
});

/** A {@link GraphEdge} on the wire. */
export const graphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(EDGE_KINDS),
  provenance: provenanceSchema.optional(),
  at: siteSchema.optional(),
  sites: z.array(siteSchema).optional(),
});

const resolutionStatsSchema = z.object({
  callsTotal: z.number(),
  callsResolved: z.number(),
  unresolved: z.record(z.string(), z.number()),
});

/** Ama → sidecar: analyze these repo-relative `files` rooted at the absolute `root`.
 *  `id` correlates the matching `result`/`error`. */
export const analyzeRequestSchema = z.object({
  type: z.literal("analyze"),
  id: z.number(),
  root: z.string(),
  files: z.array(z.string()),
});

/** Sidecar → Ama: a startup handshake announcing the language served. */
const readySchema = z.object({
  type: z.literal("ready"),
  language: z.string(),
  version: z.string().optional(),
});

/** Sidecar → Ama: the analysis of one request's files. */
const resultSchema = z.object({
  type: z.literal("result"),
  id: z.number(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  resolution: resolutionStatsSchema.optional(),
});

/** Sidecar → Ama: a failure, optionally tied to a request `id`. */
const errorSchema = z.object({
  type: z.literal("error"),
  id: z.number().optional(),
  message: z.string(),
});

/** Any message a sidecar sends to Ama. */
export const sidecarMessageSchema = z.discriminatedUnion("type", [
  readySchema,
  resultSchema,
  errorSchema,
]);

export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;
export type SidecarMessage = z.infer<typeof sidecarMessageSchema>;
export type AnalyzeResult = z.infer<typeof resultSchema>;

/** Encode a protocol message as one NDJSON line (its JSON, plus the framing newline).
 *  Used by both ends; a message must contain no raw newline of its own (JSON escapes them). */
export function frame(message: AnalyzeRequest | SidecarMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Parse one inbound line as an `analyze` request (the sidecar's side). Throws (ZodError
 *  or SyntaxError) on a malformed or invalid line. */
export function parseRequest(line: string): AnalyzeRequest {
  return analyzeRequestSchema.parse(JSON.parse(line));
}

/** Parse one inbound line as a sidecar message (Ama's side). Throws on a malformed or
 *  invalid line, so a buggy sidecar can't inject an ill-formed node/edge into the graph. */
export function parseMessage(line: string): SidecarMessage {
  return sidecarMessageSchema.parse(JSON.parse(line));
}
