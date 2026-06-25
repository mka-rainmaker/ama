#!/usr/bin/env tsx
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { JavaDeepAnalyzer } from "../src/analyzers/java-deep/analyzer.js";

interface Fixture {
  name: string;
  root: string;
}

interface Row {
  fixture: string;
  files: number;
  callsTotal: number;
  callsResolved: number;
  rate: number;
  diagnostics: Record<string, number>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const fixturesRoot = path.join(repo, "tests/fixtures");
const fixtures: Fixture[] = [
  { name: "java-deep-advanced", root: path.join(fixturesRoot, "java-deep-advanced") },
  { name: "java-deep-crossroot", root: path.join(fixturesRoot, "java-deep-crossroot") },
  { name: "java-deep-nested-types", root: path.join(fixturesRoot, "java-deep-nested-types") },
  {
    name: "java-deep-sameclass-lambda",
    root: path.join(fixturesRoot, "java-deep-sameclass-lambda"),
  },
  { name: "java-records", root: path.join(fixturesRoot, "java-records") },
];

if (process.env.AMA_JAVA_INCLUDE_STDLIB === undefined) {
  process.env.AMA_JAVA_INCLUDE_STDLIB = "0";
}

const json = process.argv.includes("--json");
const analyzer = new JavaDeepAnalyzer();
const rows: Row[] = [];

for (const fixture of fixtures) {
  const files = javaFiles(fixture.root);
  const result = await analyzer.analyze(fixture.root, files);
  const callsTotal = result.resolution?.callsTotal ?? 0;
  const callsResolved = result.resolution?.callsResolved ?? 0;
  rows.push({
    fixture: fixture.name,
    files: files.length,
    callsTotal,
    callsResolved,
    rate: callsTotal > 0 ? callsResolved / callsTotal : 0,
    diagnostics: result.resolution?.diagnostics ?? {},
  });
}

if (json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  printTable(rows);
}

function javaFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".java")) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

function printTable(rows: Row[]): void {
  console.log("fixture                         files  resolved/total  rate   diagnostics");
  for (const row of rows) {
    const diagnostics = Object.entries(row.diagnostics)
      .map(([key, value]) => `${key}:${value}`)
      .join(", ");
    console.log(
      `${row.fixture.padEnd(31)} ${String(row.files).padStart(5)}  ${`${row.callsResolved}/${row.callsTotal}`.padEnd(14)} ${`${Math.round(row.rate * 100)}%`.padStart(5)}  ${diagnostics}`,
    );
  }
}
