// A minimal sidecar emulating the ama-3bb.1 protocol over NDJSON: announce on startup,
// then for each `analyze` request emit a `result` with one deep `File` node per requested
// file. Lets the SidecarAnalyzer harness be exercised without a real Roslyn/Java sidecar.
import * as readline from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

send({ type: "ready", language: "mock" });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.type !== "analyze") return;
  const nodes = req.files.map((f) => ({
    id: f,
    kind: "File",
    name: f,
    file: f,
    qualifiedName: "",
    tier: "deep",
  }));
  send({ type: "result", id: req.id, nodes, edges: [] });
});
