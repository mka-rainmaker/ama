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
import type { AnalysisResult, Analyzer, ResolutionStats } from "../types.js";
import { analyzeJavaSourceSemantics } from "./source.js";

const TYPE_KINDS = new Set<GraphNode["kind"]>(["Class", "Interface", "Enum"]);
const SYNTHETIC = 0x1000;
const BRIDGE = 0x0040;

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

interface ParsedMethodDescriptor {
  params: JavaType[];
  returnType?: JavaType;
}

interface JavaType {
  display: string;
  binaryName?: string;
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

    const sourceSemantic = await analyzeJavaSourceSemantics(root, files, baseline);
    if (sourceSemantic) return sourceSemantic;

    const compiled = this.compile(root, files);
    if (!compiled) return { ...baseline, tier: "baseline" };

    try {
      return this.fromBytecode(root, files, baseline, compiled);
    } finally {
      fs.rmSync(compiled, { recursive: true, force: true });
    }
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
    const classpath = process.env.AMA_JAVA_CLASSPATH;
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
        if (target) addEdge(edges, edgeKeys, { from, to: target.id, kind: "UsesType" });
      }
      if (record.descriptor.returnType?.binaryName) {
        const target = typeByBinary.get(record.descriptor.returnType.binaryName);
        if (target) addEdge(edges, edgeKeys, { from, to: target.id, kind: "Returns" });
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
        addEdge(edges, edgeKeys, { from, to, kind: "Calls" });
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

function parseMethodDescriptor(descriptor: string): ParsedMethodDescriptor {
  let i = 0;
  if (descriptor[i] !== "(") return { params: [] };
  i++;
  const params: JavaType[] = [];
  while (i < descriptor.length && descriptor[i] !== ")") {
    const parsed = parseType(descriptor, i);
    params.push(parsed.type);
    i = parsed.next;
  }
  i++; // ')'
  const ret = parseType(descriptor, i);
  return { params, ...(ret.type.display !== "void" ? { returnType: ret.type } : {}) };
}

function parseType(descriptor: string, start: number): { type: JavaType; next: number } {
  const ch = descriptor[start];
  switch (ch) {
    case "B":
      return { type: { display: "byte" }, next: start + 1 };
    case "C":
      return { type: { display: "char" }, next: start + 1 };
    case "D":
      return { type: { display: "double" }, next: start + 1 };
    case "F":
      return { type: { display: "float" }, next: start + 1 };
    case "I":
      return { type: { display: "int" }, next: start + 1 };
    case "J":
      return { type: { display: "long" }, next: start + 1 };
    case "S":
      return { type: { display: "short" }, next: start + 1 };
    case "Z":
      return { type: { display: "boolean" }, next: start + 1 };
    case "V":
      return { type: { display: "void" }, next: start + 1 };
    case "L": {
      const end = descriptor.indexOf(";", start);
      const internal = end >= 0 ? descriptor.slice(start + 1, end) : descriptor.slice(start + 1);
      const binaryName = internal.replace(/\//g, ".");
      return {
        type: { display: lastSegment(binaryName.replace(/\$/g, ".")), binaryName },
        next: end + 1,
      };
    }
    case "[": {
      const parsed = parseType(descriptor, start + 1);
      return {
        type: { display: `${parsed.type.display}[]`, binaryName: parsed.type.binaryName },
        next: parsed.next,
      };
    }
    default:
      return { type: { display: "unknown" }, next: start + 1 };
  }
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
