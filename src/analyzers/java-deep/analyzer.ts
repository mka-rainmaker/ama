import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type GraphEdge, type GraphNode, fileId, symbolId } from "../../graph/index.js";
import { BaselineAnalyzer } from "../baseline/analyzer.js";
import { javaSpec } from "../baseline/java.js";
import {
  type ClassFileData,
  type ClassFileMethod,
  parseClassFile,
} from "../java-bytecode/classfile.js";
import {
  type ParsedMethodDescriptor,
  parseMethodDescriptor,
} from "../java-bytecode/descriptors.js";
import type { AnalysisResult, Analyzer, ResolutionStats } from "../types.js";
import { inferJavaRuntimeClasspathEntries, loadJavaClasspathSymbols } from "./classpath.js";
import { type JavaExternalSymbols, analyzeJavaSourceSemantics } from "./source.js";

const TYPE_KINDS = new Set<GraphNode["kind"]>(["Class", "Interface", "Enum"]);
const SYNTHETIC = 0x1000;
const BRIDGE = 0x0040;
const DEFAULT_SOURCE_CHUNK_SIZE = 0;
const DEFAULT_SOURCE_FILE_LIMIT = 8_000;

interface TypeInfo {
  binaryName: string;
  file: string;
  qualifiedName: string;
  id: string;
}

interface ParsedClass {
  rel: string;
  data: ClassFileData;
}

interface MethodRecord {
  owner: TypeInfo;
  method: ClassFileMethod;
  sourceName: string;
  descriptor: ParsedMethodDescriptor;
}

/**
 * Deep-tier Java analyzer. The default path is pure TypeScript source semantics over tree-sitter;
 * when a local javac can compile the project, bytecode descriptors provide an additional compiler
 * truth path. If both semantic paths fail, the analyzer returns the existing Java baseline result.
 */
export class JavaDeepAnalyzer implements Analyzer {
  readonly language = "java";
  readonly tier = "deep";
  readonly extensions: readonly string[] = [".java"];

  private readonly baseline = new BaselineAnalyzer(javaSpec);

  constructor(
    private readonly javac = process.env.AMA_JAVAC || "javac",
    private readonly javacArgs: readonly string[] = [],
  ) {}

  isAvailable(): boolean {
    return true;
  }

  async analyze(root: string, files: string[]): Promise<AnalysisResult> {
    const baseline = await this.baseline.analyze(root, files);
    if (files.length === 0) return { ...baseline, tier: "deep" };

    const chunkSize = javaDeepSourceChunkSize();
    const sourceFileLimit = javaDeepSourceFileLimit();
    if (chunkSize <= 0 && sourceFileLimit > 0 && files.length > sourceFileLimit) {
      console.error(
        `[ama] Java source semantic analyzer skipped ${files.length} Java file(s); the deep in-process pass is capped at ${sourceFileLimit}. Returning Java baseline; set AMA_JAVA_DEEP_CHUNK_SIZE to opt into experimental chunked deep analysis.`,
      );
      return { ...baseline, tier: "baseline" };
    }

    const dependencySymbols = loadJavaClasspathSymbols(inferJavaSymbolClasspathEntries(root));
    const sourceSemantic =
      chunkSize > 0 && files.length > chunkSize
        ? await this.analyzeSourceChunks(root, files, baseline, dependencySymbols, chunkSize)
        : await analyzeJavaSourceSemantics(root, files, baseline, dependencySymbols);
    if (sourceSemantic) return sourceSemantic;

    const compiled = this.compile(root, files);
    if (!compiled) return { ...baseline, tier: "baseline" };

    try {
      return this.fromBytecode(root, files, baseline, compiled);
    } finally {
      fs.rmSync(compiled, { recursive: true, force: true });
    }
  }

  private async analyzeSourceChunks(
    root: string,
    files: string[],
    baseline: AnalysisResult,
    dependencySymbols: JavaExternalSymbols,
    chunkSize: number,
  ): Promise<AnalysisResult | undefined> {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const nodeIds = new Set<string>();
    const edgeKeys = new Set<string>();
    const resolution: ResolutionStats = {
      callsTotal: 0,
      callsResolved: 0,
      unresolved: Object.create(null) as Record<string, number>,
      diagnostics: Object.create(null) as Record<string, number>,
    };
    const chunks = chunkFiles(files, chunkSize);
    for (const chunk of chunks) {
      const chunkBaseline = baselineForFiles(baseline, chunk);
      const analyzed = await analyzeJavaSourceSemantics(
        root,
        chunk,
        chunkBaseline,
        dependencySymbols,
      );
      const result = analyzed ?? { ...chunkBaseline, tier: "baseline" as const };
      if (!analyzed) {
        const diagnostics =
          resolution.diagnostics ?? (Object.create(null) as Record<string, number>);
        resolution.diagnostics = diagnostics;
        diagnostics["chunk-baseline-fallback"] = (diagnostics["chunk-baseline-fallback"] ?? 0) + 1;
      }
      mergeAnalysis(nodes, edges, nodeIds, edgeKeys, result);
      if (result.resolution) mergeResolution(resolution, result.resolution);
    }
    const diagnostics = resolution.diagnostics ?? (Object.create(null) as Record<string, number>);
    resolution.diagnostics = diagnostics;
    diagnostics["chunked-analysis"] = chunks.length;
    return {
      nodes,
      edges,
      tier: "deep",
      ...(resolution.callsTotal > 0 ? { resolution } : {}),
    };
  }

  private compile(root: string, files: string[]): string | undefined {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ama-java-deep-"));
    let sourceRoots: string[];
    try {
      sourceRoots = inferSourceRoots(root, files);
    } catch (err) {
      console.error(
        `[ama] javac deep analyzer could not prepare ${files.length} Java file(s); ` +
          `falling back to Java baseline. ${err instanceof Error ? err.message : String(err)}`,
      );
      fs.rmSync(outDir, { recursive: true, force: true });
      return undefined;
    }
    const args = [
      "-proc:none",
      "-g",
      "-d",
      outDir,
      "-sourcepath",
      sourceRoots.join(path.delimiter),
    ];
    const classpath = inferJavaClasspath(root);
    if (classpath) args.push("-classpath", classpath);
    args.push(...files.map((f) => path.resolve(root, f)));

    const result = spawnSync(this.javac, [...this.javacArgs, ...args], { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      const detail = result.error instanceof Error ? result.error.message : result.stderr.trim();
      console.error(
        `[ama] javac deep analyzer could not compile ${files.length} Java file(s); ` +
          `falling back to Java baseline. ${detail}`,
      );
      fs.rmSync(outDir, { recursive: true, force: true });
      return undefined;
    }
    return outDir;
  }

  private fromBytecode(
    root: string,
    files: string[],
    baseline: AnalysisResult,
    outDir: string,
  ): AnalysisResult {
    const packages = new Map(files.map((rel) => [rel, packageName(root, rel)]));
    const typeByBinary = sourceTypes(baseline.nodes, packages);
    const classes = parseCompiledClasses(outDir);
    const deepNodes = uniqueNodes(baseline.nodes).map((node) => ({
      ...node,
      tier: "deep" as const,
    }));
    const edges: GraphEdge[] = baseline.edges.filter(
      (edge) =>
        edge.kind !== "Calls" &&
        edge.provenance !== "call-ref" &&
        !(
          edge.provenance === "heuristic" &&
          (edge.kind === "Inherits" || edge.kind === "Implements")
        ),
    );

    const nodeIds = new Set(deepNodes.map((node) => node.id));
    const edgeKeys = new Set(edges.map(edgeKey));
    const methodRecords = collectMethods(classes, typeByBinary);
    const overloads = overloadCounts(methodRecords);
    const methodsByBytecode = new Map<string, string>();

    for (const record of methodRecords) {
      const qualifiedName = methodQualifiedName(record, overloads);
      const id = symbolId({ file: record.owner.file, qualifiedName });
      methodsByBytecode.set(methodKey(record.owner.binaryName, record.method), id);
      if (!nodeIds.has(id)) {
        const base = baseline.nodes.find(
          (node) =>
            node.file === record.owner.file &&
            node.kind === "Method" &&
            node.qualifiedName === `${record.owner.qualifiedName}.${record.sourceName}`,
        );
        deepNodes.push({
          id,
          kind: "Method",
          name: record.sourceName,
          file: record.owner.file,
          qualifiedName,
          range: base?.range,
          tier: "deep",
        });
        nodeIds.add(id);
        addEdge(edges, edgeKeys, { from: record.owner.id, to: id, kind: "Defines" });
      }
    }

    for (const cls of classes) {
      const from = typeByBinary.get(cls.data.thisClass);
      if (!from) continue;
      const supertype = cls.data.superClass ? typeByBinary.get(cls.data.superClass) : undefined;
      if (supertype)
        addEdge(edges, edgeKeys, { from: from.id, to: supertype.id, kind: "Inherits" });
      for (const ifaceName of cls.data.interfaces) {
        const iface = typeByBinary.get(ifaceName);
        if (!iface) continue;
        addEdge(edges, edgeKeys, {
          from: from.id,
          to: iface.id,
          kind: cls.data.isInterface ? "Inherits" : "Implements",
        });
      }
    }

    const resolution: ResolutionStats = {
      callsTotal: 0,
      callsResolved: 0,
      unresolved: Object.create(null) as Record<string, number>,
    };
    for (const record of methodRecords) {
      const from = methodsByBytecode.get(methodKey(record.owner.binaryName, record.method));
      if (!from) continue;
      for (const param of record.descriptor.params) {
        const target = param.binaryName ? typeByBinary.get(param.binaryName) : undefined;
        if (target) {
          addEdge(edges, edgeKeys, {
            from,
            to: target.id,
            kind: "UsesType",
            confidence: 1,
            strategy: "exact-type",
          });
        }
      }
      if (record.descriptor.returnType?.binaryName) {
        const target = typeByBinary.get(record.descriptor.returnType.binaryName);
        if (target) {
          addEdge(edges, edgeKeys, {
            from,
            to: target.id,
            kind: "Returns",
            confidence: 1,
            strategy: "exact-type",
          });
        }
      }
      for (const call of record.method.calls) {
        resolution.callsTotal++;
        const to = methodsByBytecode.get(methodKey(call.owner, call));
        if (!to) {
          resolution.unresolved[call.name] = (resolution.unresolved[call.name] ?? 0) + 1;
          continue;
        }
        resolution.callsResolved++;
        if (from === to) continue;
        addEdge(edges, edgeKeys, {
          from,
          to,
          kind: "Calls",
          confidence: 1,
          strategy: "exact-type",
        });
      }
    }

    return { nodes: deepNodes, edges, tier: "deep", resolution };
  }
}

function inferSourceRoots(root: string, files: string[]): string[] {
  const roots = new Set<string>([root]);
  for (const rel of files) {
    const pkg = packageName(root, rel);
    const pkgPath = pkg ? pkg.replace(/\./g, path.sep) : "";
    const dir = path.dirname(rel);
    if (pkgPath && dir.endsWith(pkgPath)) {
      roots.add(path.resolve(root, dir.slice(0, dir.length - pkgPath.length)));
    } else {
      roots.add(path.resolve(root, dir));
    }
  }
  return [...roots];
}

function javaDeepSourceChunkSize(): number {
  const raw = process.env.AMA_JAVA_DEEP_CHUNK_SIZE;
  if (!raw) return DEFAULT_SOURCE_CHUNK_SIZE;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SOURCE_CHUNK_SIZE;
}

function javaDeepSourceFileLimit(): number {
  const raw = process.env.AMA_JAVA_DEEP_MAX_FILES;
  if (!raw) return DEFAULT_SOURCE_FILE_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SOURCE_FILE_LIMIT;
}

function chunkFiles(files: string[], chunkSize: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += chunkSize) {
    chunks.push(files.slice(i, i + chunkSize));
  }
  return chunks;
}

function baselineForFiles(baseline: AnalysisResult, files: string[]): AnalysisResult {
  const fileSet = new Set(files);
  const nodes = baseline.nodes.filter((node) => fileSet.has(node.file));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: baseline.edges.filter((edge) => nodeIds.has(edge.from)),
    tier: baseline.tier,
  };
}

function mergeAnalysis(
  nodes: GraphNode[],
  edges: GraphEdge[],
  nodeIds: Set<string>,
  edgeKeys: Set<string>,
  result: AnalysisResult,
): void {
  for (const node of result.nodes) {
    if (nodeIds.has(node.id)) continue;
    nodeIds.add(node.id);
    nodes.push(node);
  }
  for (const edge of result.edges) addEdge(edges, edgeKeys, edge);
}

function mergeResolution(into: ResolutionStats, from: ResolutionStats): void {
  into.callsTotal += from.callsTotal;
  into.callsResolved += from.callsResolved;
  for (const [name, count] of Object.entries(from.unresolved)) {
    into.unresolved[name] = (into.unresolved[name] ?? 0) + count;
  }
  const diagnostics = into.diagnostics ?? (Object.create(null) as Record<string, number>);
  into.diagnostics = diagnostics;
  for (const [name, count] of Object.entries(from.diagnostics ?? {})) {
    diagnostics[name] = (diagnostics[name] ?? 0) + count;
  }
}

export function inferJavaClasspath(
  root: string,
  envClasspath = process.env.AMA_JAVA_CLASSPATH,
): string {
  return inferJavaClasspathEntries(root, envClasspath).join(path.delimiter);
}

export function inferJavaClasspathEntries(
  root: string,
  envClasspath = process.env.AMA_JAVA_CLASSPATH,
): string[] {
  const entries = new Set<string>();
  for (const entry of (envClasspath ?? "").split(path.delimiter)) {
    if (entry) entries.add(entry);
  }
  for (const rel of [
    "target/classes",
    "target/test-classes",
    "build/classes/java/main",
    "build/classes/java/test",
  ]) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) entries.add(full);
  }
  for (const rel of ["target/dependency", "build/libs"]) {
    const dir = path.join(root, rel);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jar")) entries.add(path.join(dir, entry.name));
    }
  }
  return [...entries];
}

function inferJavaSymbolClasspathEntries(root: string): string[] {
  const entries = new Set(inferJavaClasspathEntries(root));
  if (process.env.AMA_JAVA_INCLUDE_STDLIB !== "0") {
    for (const entry of inferJavaRuntimeClasspathEntries()) entries.add(entry);
  }
  return [...entries];
}

function packageName(root: string, rel: string): string {
  const source = fs.readFileSync(path.resolve(root, rel), "utf8");
  return source.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m)?.[1] ?? "";
}

function sourceTypes(nodes: GraphNode[], packages: Map<string, string>): Map<string, TypeInfo> {
  const out = new Map<string, TypeInfo>();
  for (const node of nodes) {
    if (!TYPE_KINDS.has(node.kind)) continue;
    const pkg = packages.get(node.file) ?? "";
    const binaryName = [pkg, node.qualifiedName.replace(/\./g, "$")].filter(Boolean).join(".");
    out.set(binaryName, {
      binaryName,
      file: node.file,
      qualifiedName: node.qualifiedName,
      id: node.id,
    });
  }
  return out;
}

function uniqueNodes(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function parseCompiledClasses(outDir: string): ParsedClass[] {
  const out: ParsedClass[] = [];
  for (const file of walkFiles(outDir)) {
    if (!file.endsWith(".class")) continue;
    const rel = path.relative(outDir, file).split(path.sep).join("/");
    out.push({ rel, data: parseClassFile(new Uint8Array(fs.readFileSync(file))) });
  }
  return out;
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

function collectMethods(
  classes: ParsedClass[],
  typeByBinary: Map<string, TypeInfo>,
): MethodRecord[] {
  const records: MethodRecord[] = [];
  for (const cls of classes) {
    const owner = typeByBinary.get(cls.data.thisClass);
    if (!owner) continue;
    for (const method of cls.data.methods) {
      if (method.name === "<clinit>" || (method.accessFlags & (SYNTHETIC | BRIDGE)) !== 0) continue;
      const sourceName = method.name === "<init>" ? lastSegment(owner.qualifiedName) : method.name;
      records.push({
        owner,
        method,
        sourceName,
        descriptor: parseMethodDescriptor(method.descriptor),
      });
    }
  }
  return records;
}

function overloadCounts(records: MethodRecord[]): Map<string, number> {
  const descriptors = new Map<string, Set<string>>();
  for (const record of records) {
    const key = `${record.owner.binaryName}#${record.sourceName}`;
    const set = descriptors.get(key);
    if (set) set.add(record.method.descriptor);
    else descriptors.set(key, new Set([record.method.descriptor]));
  }
  return new Map([...descriptors].map(([key, set]) => [key, set.size]));
}

function methodQualifiedName(record: MethodRecord, overloads: Map<string, number>): string {
  const base = `${record.owner.qualifiedName}.${record.sourceName}`;
  const count = overloads.get(`${record.owner.binaryName}#${record.sourceName}`) ?? 1;
  if (count <= 1) return base;
  return `${base}(${record.descriptor.params.map((p) => p.display).join(", ")})`;
}

function methodKey(owner: string, method: { name: string; descriptor: string }): string {
  return `${owner}#${method.name}#${method.descriptor}`;
}

function lastSegment(name: string): string {
  return name.split(".").pop() ?? name;
}

function addEdge(edges: GraphEdge[], keys: Set<string>, edge: GraphEdge): void {
  const key = edgeKey(edge);
  if (keys.has(key)) return;
  keys.add(key);
  edges.push(edge);
}

function edgeKey(edge: GraphEdge): string {
  return JSON.stringify([edge.from, edge.to, edge.kind]);
}
