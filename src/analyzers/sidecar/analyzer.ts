import { spawn } from "node:child_process";
import * as readline from "node:readline";
import type { AnalysisResult, Analyzer } from "../types.js";
import { type AnalyzeRequest, frame, parseMessage } from "./protocol.js";

/**
 * Drives an out-of-process deep analyzer (a "sidecar") over the {@link ./protocol.ts}
 * contract. Implements {@link Analyzer} (tier `deep`) so it plugs in alongside the
 * in-process analyzers, but delegates the actual work to a subprocess (e.g. a Roslyn or
 * native-Java tool) that speaks NDJSON over stdio.
 *
 * One subprocess per `analyze` call (one per language batch per index): spawn, send the
 * `analyze` request on stdin, read the matching `result` from stdout, then tear it down.
 * The sidecar's stderr is inherited so its logs reach Ama's stderr, never the protocol
 * stream. A spawn failure, a malformed message, an `error` reply, or an exit-without-result
 * rejects — the indexer's per-analyzer isolation then skips this language (graceful
 * fall-through to baseline is the routing layer's job, ama-3bb.4). (ama-3bb.1)
 */
export class SidecarAnalyzer implements Analyzer {
  readonly tier = "deep";

  constructor(
    readonly language: string,
    readonly extensions: readonly string[],
    private readonly command: string,
    private readonly args: readonly string[] = [],
  ) {}

  analyze(root: string, files: string[]): Promise<AnalysisResult> {
    const request: AnalyzeRequest = { type: "analyze", id: 1, root, files };
    return new Promise<AnalysisResult>((resolve, reject) => {
      const child = spawn(this.command, [...this.args], { stdio: ["pipe", "pipe", "inherit"] });
      let settled = false;
      const finish = (run: () => void): void => {
        if (settled) return;
        settled = true;
        child.kill();
        run();
      };

      child.on("error", (err) => finish(() => reject(err))); // spawn failure (ENOENT, …)
      child.on("exit", () => {
        if (!settled) reject(new Error(`${this.language} sidecar exited without a result`));
      });
      // Writing to a sidecar that failed to spawn can emit EPIPE; the `error`/`exit`
      // handlers carry the real failure, so swallow the stream error to avoid a crash.
      child.stdin?.on("error", () => {});

      if (!child.stdout) {
        finish(() => reject(new Error(`${this.language} sidecar has no stdout`)));
        return;
      }
      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (settled) return;
        let msg: ReturnType<typeof parseMessage>;
        try {
          msg = parseMessage(line);
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error(String(err))));
          return;
        }
        if (msg.type === "result" && msg.id === request.id) {
          finish(() => resolve({ nodes: msg.nodes, edges: msg.edges, resolution: msg.resolution }));
        } else if (msg.type === "error") {
          finish(() => reject(new Error(msg.message)));
        }
        // `ready` (and any unrelated result id) is ignored.
      });

      child.stdin?.write(frame(request));
      child.stdin?.end();
    });
  }
}
