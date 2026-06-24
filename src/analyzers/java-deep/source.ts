import * as fs from "node:fs";
import * as path from "node:path";
import type Parser from "web-tree-sitter";
import { type GraphEdge, type GraphNode, symbolId } from "../../graph/index.js";
import { parse } from "../baseline/treesitter.js";
import type { AnalysisResult, ResolutionStats } from "../types.js";

const TYPE_KINDS = new Set<GraphNode["kind"]>(["Class", "Interface", "Enum"]);
const TYPE_DECLS = new Set([
  "class_declaration",
  "record_declaration",
  "interface_declaration",
  "enum_declaration",
]);
const METHOD_DECLS = new Set(["method_declaration", "constructor_declaration"]);
const SPRING_MAPPING_VERBS = new Map([
  ["GetMapping", "GET"],
  ["PostMapping", "POST"],
  ["PutMapping", "PUT"],
  ["DeleteMapping", "DELETE"],
  ["PatchMapping", "PATCH"],
]);
const REQUEST_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);
const REQUEST_METHOD_REGEXES = [...REQUEST_METHODS].map(
  (method) => [method, new RegExp(`\\bRequestMethod\\.${method}\\b`)] as const,
);
const PRIMITIVES = new Set([
  "byte",
  "char",
  "double",
  "float",
  "int",
  "long",
  "short",
  "boolean",
  "void",
]);

interface FileContext {
  rel: string;
  packageName: string;
  imports: ImportInfo[];
  tree: Parser.Tree;
}

interface ImportInfo {
  imported?: string;
  wildcardPackage?: string;
}

interface TypeInfo {
  binaryName: string;
  file: string;
  qualifiedName: string;
  simpleName: string;
  id: string;
  node?: Parser.SyntaxNode;
}

interface MethodInfo {
  node: Parser.SyntaxNode;
  owner: TypeInfo;
  sourceName: string;
  params: ParamInfo[];
  returnType?: JavaType;
  range: { startLine: number; endLine: number };
  id?: string;
}

interface ParamInfo {
  name?: string;
  type: JavaType;
}

interface JavaType {
  display: string;
  binaryName?: string;
}

interface SpringAnnotationMapping {
  verbs: string[];
  paths: string[];
}

interface SpringRouteMapping {
  verbs: string[];
  paths: string[];
}

/**
 * Pure TypeScript Java semantic slice: build a source symbol/type index from tree-sitter, then use
 * resolved receiver + argument types to wire exact in-repo call edges, including overloaded methods.
 */
export async function analyzeJavaSourceSemantics(
  root: string,
  files: string[],
  baseline: AnalysisResult,
): Promise<AnalysisResult | undefined> {
  const contexts: FileContext[] = [];
  try {
    for (const rel of files) {
      const code = fs.readFileSync(path.resolve(root, rel), "utf8");
      contexts.push({
        rel,
        packageName: packageNameFromSource(code),
        imports: importsFromSource(code),
        tree: await parse("java", code),
      });
    }

    const types = collectTypes(contexts, baseline.nodes);
    const methods = collectMethods(contexts, types);
    const fields = collectFields(types, contexts);
    return emitSourceSemanticGraph(baseline, contexts, types, methods, fields);
  } catch (err) {
    console.error(
      `[ama] Java source semantic analyzer failed; falling back. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  } finally {
    for (const ctx of contexts) ctx.tree.delete();
  }
}

function emitSourceSemanticGraph(
  baseline: AnalysisResult,
  contexts: FileContext[],
  types: Map<string, TypeInfo>,
  methods: MethodInfo[],
  fieldsByOwner: Map<string, Map<string, JavaType>>,
): AnalysisResult {
  const byOwnerName = new Map<string, MethodInfo[]>();
  for (const method of methods) {
    const key = `${method.owner.binaryName}#${method.sourceName}`;
    const list = byOwnerName.get(key);
    if (list) list.push(method);
    else byOwnerName.set(key, [method]);
  }
  const localsByMethod = collectLocalVariables(methods, contexts, types);

  const nodes: GraphNode[] = uniqueNodes(baseline.nodes).map((node) => ({
    ...node,
    tier: "deep" as const,
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = baseline.edges.filter(
    (edge) => edge.kind !== "Calls" && edge.provenance !== "call-ref",
  );
  const edgeKeys = new Set(edges.map(edgeKey));

  for (const method of methods) {
    const overloads = byOwnerName.get(`${method.owner.binaryName}#${method.sourceName}`) ?? [];
    const qualifiedName =
      overloads.length > 1
        ? `${method.owner.qualifiedName}.${method.sourceName}(${method.params
            .map((p) => p.type.display)
            .join(", ")})`
        : `${method.owner.qualifiedName}.${method.sourceName}`;
    method.id = symbolId({ file: method.owner.file, qualifiedName });
    if (!nodeIds.has(method.id)) {
      nodes.push({
        id: method.id,
        kind: "Method",
        name: method.sourceName,
        file: method.owner.file,
        qualifiedName,
        range: method.range,
        tier: "deep",
      });
      nodeIds.add(method.id);
      addEdge(edges, edgeKeys, { from: method.owner.id, to: method.id, kind: "Defines" });
    }
  }

  for (const method of methods) {
    if (!method.id) continue;
    for (const param of method.params) {
      const target = param.type.binaryName ? types.get(param.type.binaryName) : undefined;
      if (target) addEdge(edges, edgeKeys, { from: method.id, to: target.id, kind: "UsesType" });
    }
    if (method.returnType?.binaryName) {
      const target = types.get(method.returnType.binaryName);
      if (target) addEdge(edges, edgeKeys, { from: method.id, to: target.id, kind: "Returns" });
    }
  }

  emitHierarchyEdges(types, contexts, edges, edgeKeys);
  const sourceRoutes = collectSpringRoutes(contexts);
  replaceBaselineRoutesForHandlers(nodes, nodeIds, edges, edgeKeys, sourceRoutes, contexts);
  for (const node of sourceRoutes.nodes) {
    if (nodeIds.has(node.id)) continue;
    nodes.push(node);
    nodeIds.add(node.id);
  }
  for (const edge of sourceRoutes.edges) addEdge(edges, edgeKeys, edge);

  const resolution: ResolutionStats = {
    callsTotal: 0,
    callsResolved: 0,
    unresolved: Object.create(null) as Record<string, number>,
  };
  const methodsByNode = new Map(
    methods.map((method) => [nodeKey(method.owner.file, method.node), method]),
  );
  for (const ctx of contexts) {
    for (const call of eachOfType(ctx.tree.rootNode, "method_invocation")) {
      const caller = enclosingMethod(call, ctx.rel, methodsByNode);
      const name = call.childForFieldName("name")?.text;
      if (!caller?.id || !name) continue;
      resolution.callsTotal++;
      const receiver = resolveReceiverType(
        call.childForFieldName("object"),
        caller,
        ctx,
        types,
        fieldsByOwner,
        localsByMethod,
      );
      if (!receiver) {
        resolution.unresolved[name] = (resolution.unresolved[name] ?? 0) + 1;
        continue;
      }
      const argTypes = (call.childForFieldName("arguments")?.namedChildren ?? []).map((arg) =>
        inferExpressionType(arg, caller, ctx, types, fieldsByOwner, localsByMethod),
      );
      const target = resolveMethod(receiver, name, argTypes, byOwnerName);
      if (!target?.id) {
        resolution.unresolved[name] = (resolution.unresolved[name] ?? 0) + 1;
        continue;
      }
      resolution.callsResolved++;
      if (target.id === caller.id) continue;
      addEdge(edges, edgeKeys, { from: caller.id, to: target.id, kind: "Calls" });
    }
  }

  return { nodes, edges, tier: "deep", resolution };
}

function collectSpringRoutes(contexts: FileContext[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const metadata = collectSpringAnnotationMetadata(contexts);
  const out = { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
  const routeKeys = new Set<string>();
  for (const ctx of contexts) {
    for (const cls of eachRouteHost(ctx.tree.rootNode)) {
      const prefixes = classRoutePrefixes(cls, ctx, metadata);
      const body = cls.childForFieldName("body");
      for (const member of body?.namedChildren ?? []) {
        if (member.type !== "method_declaration") continue;
        const handlerQn = javaQualifiedName(member);
        if (!handlerQn) continue;
        const mappings = methodRouteMappings(member, ctx, metadata);
        for (const mapping of mappings) {
          for (const verb of mapping.verbs) {
            for (const prefix of prefixes) {
              for (const subPath of mapping.paths) {
                const routePath = joinJavaRoutePath(prefix, subPath);
                const routeName = `${verb} ${routePath}`;
                const routeId = symbolId({ file: ctx.rel, qualifiedName: routeName });
                const routeKey = `${routeId} ${handlerQn}`;
                if (routeKeys.has(routeKey)) continue;
                routeKeys.add(routeKey);
                out.nodes.push({
                  id: routeId,
                  kind: "Route",
                  name: routeName,
                  file: ctx.rel,
                  qualifiedName: routeName,
                  tier: "deep",
                  range: {
                    startLine: member.startPosition.row + 1,
                    endLine: member.endPosition.row + 1,
                  },
                });
                out.edges.push({
                  from: routeId,
                  to: symbolId({ file: ctx.rel, qualifiedName: handlerQn }),
                  kind: "References",
                  provenance: "resolved",
                });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

function collectSpringAnnotationMetadata(
  contexts: FileContext[],
): Map<string, SpringAnnotationMapping> {
  const out = new Map<string, SpringAnnotationMapping>();
  for (const ctx of contexts) {
    for (const decl of eachOfType(ctx.tree.rootNode, "annotation_type_declaration")) {
      const simpleName = declarationName(decl);
      if (!simpleName) continue;
      const mapping: SpringAnnotationMapping = { verbs: [], paths: [] };
      for (const ann of annotationsOf(decl)) {
        const direct = directSpringMapping(ann);
        if (!direct) continue;
        for (const verb of direct.verbs) pushUnique(mapping.verbs, verb);
        for (const routePath of direct.paths) pushUnique(mapping.paths, routePath);
      }
      if (mapping.verbs.length === 0 && mapping.paths.length === 0) continue;
      const qualified = [ctx.packageName, simpleName].filter(Boolean).join(".");
      out.set(simpleName, mapping);
      if (qualified) out.set(qualified, mapping);
    }
  }
  return out;
}

function classRoutePrefixes(
  cls: Parser.SyntaxNode,
  ctx: FileContext,
  metadata: Map<string, SpringAnnotationMapping>,
): string[] {
  const prefixes: string[] = [];
  for (const ann of annotationsOf(cls)) {
    const mapping = routeMappingForAnnotation(ann, ctx, metadata);
    if (!mapping || mapping.verbs.length > 0) continue;
    for (const routePath of mapping.paths) pushUnique(prefixes, routePath);
  }
  return prefixes.length > 0 ? prefixes : [""];
}

function methodRouteMappings(
  method: Parser.SyntaxNode,
  ctx: FileContext,
  metadata: Map<string, SpringAnnotationMapping>,
): SpringRouteMapping[] {
  const out: SpringRouteMapping[] = [];
  for (const ann of annotationsOf(method)) {
    const mapping = routeMappingForAnnotation(ann, ctx, metadata);
    if (!mapping || mapping.verbs.length === 0) continue;
    out.push(mapping);
  }
  return out;
}

function routeMappingForAnnotation(
  ann: Parser.SyntaxNode,
  ctx: FileContext,
  metadata: Map<string, SpringAnnotationMapping>,
): SpringRouteMapping | undefined {
  const direct = directSpringMapping(ann);
  if (direct) return direct;
  const meta = springMetadataForAnnotation(ann, ctx, metadata);
  if (!meta) return undefined;
  return {
    verbs: [...meta.verbs],
    paths: annotationPaths(ann) ?? (meta.paths.length > 0 ? [...meta.paths] : [""]),
  };
}

function directSpringMapping(ann: Parser.SyntaxNode): SpringRouteMapping | undefined {
  const name = annotationSimpleName(ann);
  if (!name) return undefined;
  const verb = SPRING_MAPPING_VERBS.get(name);
  if (verb) return { verbs: [verb], paths: annotationPaths(ann) ?? [""] };
  if (name !== "RequestMapping") return undefined;
  return { verbs: requestMappingVerbs(ann), paths: annotationPaths(ann) ?? [""] };
}

function springMetadataForAnnotation(
  ann: Parser.SyntaxNode,
  ctx: FileContext,
  metadata: Map<string, SpringAnnotationMapping>,
): SpringAnnotationMapping | undefined {
  const simpleName = annotationSimpleName(ann);
  if (!simpleName) return undefined;
  for (const candidate of annotationNameCandidates(simpleName, ctx)) {
    const mapping = metadata.get(candidate);
    if (mapping) return mapping;
  }
  return undefined;
}

function annotationNameCandidates(simpleName: string, ctx: FileContext): string[] {
  const out = [simpleName];
  for (const imp of ctx.imports) {
    if (imp.imported && lastSegment(imp.imported) === simpleName) out.push(imp.imported);
  }
  out.push([ctx.packageName, simpleName].filter(Boolean).join("."));
  for (const imp of ctx.imports) {
    if (imp.wildcardPackage) out.push(`${imp.wildcardPackage}.${simpleName}`);
  }
  return out;
}

function requestMappingVerbs(ann: Parser.SyntaxNode): string[] {
  const pair = annotationPairs(ann).find((p) => p.namedChildren[0]?.text === "method");
  if (!pair) return [];
  const verbs: string[] = [];
  for (const [method, regex] of REQUEST_METHOD_REGEXES) {
    if (regex.test(pair.text)) verbs.push(method);
  }
  return verbs;
}

function annotationPaths(ann: Parser.SyntaxNode): string[] | undefined {
  const argList = ann.namedChildren.find((child) => child.type === "annotation_argument_list");
  if (!argList) return undefined;
  const pairs = annotationPairs(ann);
  if (pairs.length > 0) {
    for (const key of ["value", "path"]) {
      const pair = pairs.find((p) => p.namedChildren[0]?.text === key);
      if (pair) return stringFragments(pair);
    }
    return undefined;
  }
  return stringFragments(argList);
}

function annotationPairs(ann: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const argList = ann.namedChildren.find((child) => child.type === "annotation_argument_list");
  return argList?.namedChildren.filter((child) => child.type === "element_value_pair") ?? [];
}

function annotationsOf(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return (
    node.namedChildren.find((child) => child.type === "modifiers")?.namedChildren ?? []
  ).filter((child) => child.type === "annotation" || child.type === "marker_annotation");
}

function annotationSimpleName(ann: Parser.SyntaxNode): string | undefined {
  const nameNode = ann.childForFieldName("name");
  if (!nameNode) return undefined;
  if (nameNode.type === "identifier") return nameNode.text;
  const ids = nameNode.namedChildren.filter((child) => child.type === "identifier");
  return ids[ids.length - 1]?.text ?? nameNode.text;
}

function declarationName(node: Parser.SyntaxNode): string | undefined {
  return (
    node.childForFieldName("name")?.text ??
    node.namedChildren.find((child) => child.type === "identifier")?.text
  );
}

function stringFragments(node: Parser.SyntaxNode): string[] {
  return [...eachOfType(node, "string_fragment")].map((fragment) => fragment.text);
}

function joinJavaRoutePath(prefix: string, sub: string): string {
  const stripSlashes = (s: string) => s.replace(/^\/+|\/+$/g, "");
  const joined = [stripSlashes(prefix), stripSlashes(sub)].filter(Boolean).join("/");
  return `/${joined.replace(/(?<!\$)\{([^}]+)\}/g, ":$1")}`;
}

function replaceBaselineRoutesForHandlers(
  nodes: GraphNode[],
  nodeIds: Set<string>,
  edges: GraphEdge[],
  edgeKeys: Set<string>,
  sourceRoutes: { nodes: GraphNode[]; edges: GraphEdge[] },
  contexts: FileContext[],
): void {
  const javaFiles = new Set(contexts.map((ctx) => ctx.rel));
  const handlers = new Set(
    sourceRoutes.edges.filter((edge) => edge.kind === "References").map((edge) => edge.to),
  );
  if (handlers.size === 0) return;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const routeIds = new Set<string>();
  for (const edge of edges) {
    const route = nodeById.get(edge.from);
    if (
      edge.kind === "References" &&
      handlers.has(edge.to) &&
      route?.kind === "Route" &&
      javaFiles.has(route.file)
    ) {
      routeIds.add(edge.from);
    }
  }
  if (routeIds.size === 0) return;

  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node || !routeIds.has(node.id)) continue;
    nodes.splice(i, 1);
    nodeIds.delete(node.id);
  }
  for (let i = edges.length - 1; i >= 0; i--) {
    const edge = edges[i];
    if (!edge || !routeIds.has(edge.from)) continue;
    edges.splice(i, 1);
    edgeKeys.delete(edgeKey(edge));
  }
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function packageNameFromSource(code: string): string {
  return code.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m)?.[1] ?? "";
}

function importsFromSource(code: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  for (const match of code.matchAll(
    /^\s*import\s+(?:static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\.\*)?)\s*;/gm,
  )) {
    const spec = match[1];
    if (!spec) continue;
    if (spec.endsWith(".*")) imports.push({ wildcardPackage: spec.slice(0, -2) });
    else imports.push({ imported: spec });
  }
  return imports;
}

function collectTypes(contexts: FileContext[], nodes: GraphNode[]): Map<string, TypeInfo> {
  const packageByFile = new Map(contexts.map((ctx) => [ctx.rel, ctx.packageName]));
  const declarationByFileAndName = new Map<string, Parser.SyntaxNode>();
  for (const ctx of contexts) {
    for (const node of eachType(ctx.tree.rootNode)) {
      const qn = javaQualifiedName(node);
      if (qn) declarationByFileAndName.set(`${ctx.rel}#${qn}`, node);
    }
  }
  const out = new Map<string, TypeInfo>();
  for (const node of nodes) {
    if (!TYPE_KINDS.has(node.kind)) continue;
    const pkg = packageByFile.get(node.file) ?? "";
    const binaryName = [pkg, node.qualifiedName.replace(/\./g, "$")].filter(Boolean).join(".");
    out.set(binaryName, {
      binaryName,
      file: node.file,
      qualifiedName: node.qualifiedName,
      simpleName: node.name,
      id: node.id,
      node: declarationByFileAndName.get(`${node.file}#${node.qualifiedName}`),
    });
  }
  return out;
}

function* eachType(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  if (TYPE_DECLS.has(node.type)) yield node;
  for (const child of node.namedChildren) yield* eachType(child);
}

function* eachRouteHost(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  if (node.type === "class_declaration" || node.type === "record_declaration") yield node;
  for (const child of node.namedChildren) yield* eachRouteHost(child);
}

function collectMethods(contexts: FileContext[], types: Map<string, TypeInfo>): MethodInfo[] {
  const out: MethodInfo[] = [];
  for (const ctx of contexts) {
    for (const node of eachMethod(ctx.tree.rootNode)) {
      const owner = ownerType(node, ctx, types);
      if (!owner) continue;
      const sourceName =
        node.type === "constructor_declaration"
          ? owner.simpleName
          : (node.childForFieldName("name")?.text ?? "");
      if (!sourceName) continue;
      out.push({
        node,
        owner,
        sourceName,
        params: methodParams(node, ctx, types),
        returnType:
          node.type === "method_declaration"
            ? javaTypeFromNode(node.childForFieldName("type"), ctx, types)
            : undefined,
        range: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
      });
    }
  }
  return out;
}

function* eachMethod(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  if (METHOD_DECLS.has(node.type)) yield node;
  for (const child of node.namedChildren) yield* eachMethod(child);
}

function collectFields(
  types: Map<string, TypeInfo>,
  contexts: FileContext[],
): Map<string, Map<string, JavaType>> {
  const contextByFile = new Map(contexts.map((ctx) => [ctx.rel, ctx]));
  const out = new Map<string, Map<string, JavaType>>();
  for (const type of types.values()) {
    if (!type.node) continue;
    const ctx = contextByFile.get(type.file);
    const body = type.node.childForFieldName("body");
    if (!ctx || !body) continue;
    const fields = new Map<string, JavaType>();
    if (type.node.type === "record_declaration") {
      const params = type.node.childForFieldName("parameters");
      for (const param of params?.namedChildren ?? []) {
        if (param.type !== "formal_parameter") continue;
        const fieldType = javaTypeFromNode(param.childForFieldName("type"), ctx, types);
        const name = param.childForFieldName("name")?.text;
        if (fieldType && name) fields.set(name, fieldType);
      }
    }
    for (const member of body.namedChildren) {
      if (member.type !== "field_declaration") continue;
      const fieldType = javaTypeFromNode(member.childForFieldName("type"), ctx, types);
      if (!fieldType) continue;
      for (const declarator of member.namedChildren) {
        if (declarator.type !== "variable_declarator") continue;
        const name = declarator.childForFieldName("name")?.text;
        if (name) fields.set(name, fieldType);
      }
    }
    if (fields.size > 0) out.set(type.binaryName, fields);
  }
  return out;
}

function collectLocalVariables(
  methods: MethodInfo[],
  contexts: FileContext[],
  types: Map<string, TypeInfo>,
): Map<MethodInfo, Map<string, JavaType>> {
  const contextByFile = new Map(contexts.map((ctx) => [ctx.rel, ctx]));
  const out = new Map<MethodInfo, Map<string, JavaType>>();
  for (const method of methods) {
    const ctx = contextByFile.get(method.owner.file);
    if (!ctx) continue;
    const locals = new Map<string, JavaType>();
    for (const decl of eachOfType(method.node, "local_variable_declaration")) {
      const type = javaTypeFromNode(decl.childForFieldName("type"), ctx, types);
      if (!type) continue;
      for (const variable of decl.namedChildren) {
        if (variable.type !== "variable_declarator") continue;
        const name = variable.childForFieldName("name")?.text;
        if (name) locals.set(name, type);
      }
    }
    if (locals.size > 0) out.set(method, locals);
  }
  return out;
}

function emitHierarchyEdges(
  types: Map<string, TypeInfo>,
  contexts: FileContext[],
  edges: GraphEdge[],
  edgeKeys: Set<string>,
): void {
  const contextByFile = new Map(contexts.map((ctx) => [ctx.rel, ctx]));
  const link = (from: TypeInfo, supertype: Parser.SyntaxNode, kind: "Inherits" | "Implements") => {
    const ctx = contextByFile.get(from.file);
    if (!ctx) return;
    const targetType = javaTypeFromNode(supertype, ctx, types);
    const target = targetType?.binaryName ? types.get(targetType.binaryName) : undefined;
    if (!target || target.id === from.id) return;
    addEdge(edges, edgeKeys, { from: from.id, to: target.id, kind });
  };

  for (const type of types.values()) {
    const node = type.node;
    if (!node) continue;
    if (node.type === "class_declaration") {
      const sup = node.childForFieldName("superclass")?.namedChildren[0];
      if (sup) link(type, sup, "Inherits");
      for (const iface of typeListMembers(node.childForFieldName("interfaces") ?? undefined)) {
        link(type, iface, "Implements");
      }
    } else if (node.type === "record_declaration" || node.type === "enum_declaration") {
      for (const iface of typeListMembers(node.childForFieldName("interfaces") ?? undefined)) {
        link(type, iface, "Implements");
      }
    } else if (node.type === "interface_declaration") {
      const ext = node.namedChildren.find((child) => child.type === "extends_interfaces");
      for (const iface of typeListMembers(ext)) link(type, iface, "Inherits");
    }
  }
}

function typeListMembers(list: Parser.SyntaxNode | undefined): Parser.SyntaxNode[] {
  const typeList = list?.namedChildren.find((child) => child.type === "type_list");
  return typeList ? [...typeList.namedChildren] : [];
}

function ownerType(
  node: Parser.SyntaxNode,
  ctx: FileContext,
  types: Map<string, TypeInfo>,
): TypeInfo | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (!TYPE_DECLS.has(p.type)) continue;
    const qn = javaQualifiedName(p);
    if (!qn) return undefined;
    return types.get([ctx.packageName, qn.replace(/\./g, "$")].filter(Boolean).join("."));
  }
  return undefined;
}

function javaQualifiedName(node: Parser.SyntaxNode): string | undefined {
  const parts: string[] = [];
  for (let n: Parser.SyntaxNode | null = node; n; n = n.parent) {
    if (!TYPE_DECLS.has(n.type) && !METHOD_DECLS.has(n.type)) continue;
    const name = n.childForFieldName("name")?.text;
    if (!name) return undefined;
    parts.unshift(name);
  }
  return parts.length ? parts.join(".") : undefined;
}

function methodParams(
  node: Parser.SyntaxNode,
  ctx: FileContext,
  types: Map<string, TypeInfo>,
): ParamInfo[] {
  const params = node.childForFieldName("parameters");
  const out: ParamInfo[] = [];
  for (const param of params?.namedChildren ?? []) {
    if (param.type !== "formal_parameter" && param.type !== "spread_parameter") continue;
    const type = javaTypeFromNode(param.childForFieldName("type"), ctx, types);
    if (!type) continue;
    out.push({ name: param.childForFieldName("name")?.text, type });
  }
  return out;
}

function javaTypeFromNode(
  node: Parser.SyntaxNode | null | undefined,
  ctx: FileContext,
  types: Map<string, TypeInfo>,
): JavaType | undefined {
  if (!node) return undefined;
  const base = baseTypeName(node);
  if (!base) return undefined;
  if (PRIMITIVES.has(base)) return { display: base };
  const binaryName = resolveTypeBinaryName(base, ctx, types);
  return { display: lastSegment(base), ...(binaryName ? { binaryName } : {}) };
}

function baseTypeName(node: Parser.SyntaxNode): string | undefined {
  switch (node.type) {
    case "type_identifier":
    case "identifier":
      return node.text;
    case "integral_type":
    case "floating_point_type":
    case "boolean_type":
    case "void_type":
      return node.text;
    case "generic_type":
      return node.namedChildren[0] ? baseTypeName(node.namedChildren[0]) : undefined;
    case "array_type":
      return node.namedChildren[0] ? baseTypeName(node.namedChildren[0]) : undefined;
    case "scoped_type_identifier":
    case "scoped_identifier":
      return node.text;
    default:
      return undefined;
  }
}

function resolveTypeBinaryName(
  name: string,
  ctx: FileContext,
  types: Map<string, TypeInfo>,
): string | undefined {
  const normalized = name.replace(/\$/g, ".");
  const nested = resolveNestedTypeBinaryName(normalized, ctx, types);
  if (nested) return nested;
  if (normalized.includes(".")) return normalized;
  return resolveSimpleTypeBinaryName(normalized, ctx, types);
}

function resolveSimpleTypeBinaryName(
  name: string,
  ctx: FileContext,
  types: Map<string, TypeInfo>,
): string | undefined {
  const normalized = name.replace(/\$/g, ".");
  if (normalized === "String") return "java.lang.String";
  for (const imp of ctx.imports) {
    if (imp.imported && lastSegment(imp.imported) === normalized) return imp.imported;
  }
  const samePackage = [ctx.packageName, normalized].filter(Boolean).join(".");
  if (types.has(samePackage)) return samePackage;
  for (const imp of ctx.imports) {
    if (!imp.wildcardPackage) continue;
    const candidate = `${imp.wildcardPackage}.${normalized}`;
    if (types.has(candidate)) return candidate;
  }
  return undefined;
}

function resolveNestedTypeBinaryName(
  name: string,
  ctx: FileContext,
  types: Map<string, TypeInfo>,
): string | undefined {
  if (!name.includes(".")) return undefined;
  const parts = name.split(".");
  for (let i = parts.length - 1; i >= 1; i--) {
    const outerName = parts.slice(0, i).join(".");
    const nestedName = parts.slice(i).join("$");
    const outerBinary = resolveOuterTypeBinaryName(outerName, ctx, types);
    if (!outerBinary) continue;
    const candidate = `${outerBinary}$${nestedName}`;
    if (types.has(candidate)) return candidate;
  }
  return undefined;
}

function resolveOuterTypeBinaryName(
  name: string,
  ctx: FileContext,
  types: Map<string, TypeInfo>,
): string | undefined {
  const normalized = name.replace(/\$/g, ".");
  if (normalized.includes(".")) return types.has(normalized) ? normalized : undefined;
  return resolveSimpleTypeBinaryName(normalized, ctx, types);
}

function enclosingMethod(
  node: Parser.SyntaxNode,
  file: string,
  methodsByNode: Map<string, MethodInfo>,
): MethodInfo | undefined {
  for (let p = node.parent; p; p = p.parent) {
    const method = methodsByNode.get(nodeKey(file, p));
    if (method) return method;
  }
  return undefined;
}

function resolveReceiverType(
  receiver: Parser.SyntaxNode | null | undefined,
  caller: MethodInfo,
  ctx: FileContext,
  types: Map<string, TypeInfo>,
  fieldsByOwner: Map<string, Map<string, JavaType>>,
  localsByMethod: Map<MethodInfo, Map<string, JavaType>>,
): TypeInfo | undefined {
  if (!receiver) return caller.owner;
  if (receiver.type === "this") return caller.owner;
  if (receiver.type === "field_access") {
    const fieldType = fieldAccessType(receiver, caller, ctx, types, fieldsByOwner, localsByMethod);
    return fieldType?.binaryName ? types.get(fieldType.binaryName) : undefined;
  }
  if (receiver.type === "identifier" && /^[A-Z]/.test(receiver.text)) {
    const binaryName = resolveTypeBinaryName(receiver.text, ctx, types);
    return binaryName ? types.get(binaryName) : undefined;
  }
  if (receiver.type === "scoped_identifier") {
    const binaryName = resolveTypeBinaryName(receiver.text, ctx, types);
    return binaryName ? types.get(binaryName) : undefined;
  }
  if (receiver.type === "identifier") {
    const varType = variableType(receiver.text, caller, fieldsByOwner, localsByMethod);
    return varType?.binaryName ? types.get(varType.binaryName) : undefined;
  }
  return undefined;
}

function fieldAccessType(
  receiver: Parser.SyntaxNode,
  caller: MethodInfo,
  ctx: FileContext,
  types: Map<string, TypeInfo>,
  fieldsByOwner: Map<string, Map<string, JavaType>>,
  localsByMethod: Map<MethodInfo, Map<string, JavaType>>,
): JavaType | undefined {
  const name = receiver.childForFieldName("field")?.text;
  if (!name) return undefined;
  const object = receiver.childForFieldName("object");
  if (!object || object.type === "this" || object.type === "super") {
    return fieldsByOwner.get(caller.owner.binaryName)?.get(name);
  }
  const owner = resolveReceiverType(object, caller, ctx, types, fieldsByOwner, localsByMethod);
  return owner ? fieldsByOwner.get(owner.binaryName)?.get(name) : undefined;
}

function variableType(
  name: string,
  method: MethodInfo,
  fieldsByOwner: Map<string, Map<string, JavaType>>,
  localsByMethod: Map<MethodInfo, Map<string, JavaType>>,
): JavaType | undefined {
  const param = method.params.find((p) => p.name === name);
  if (param) return param.type;
  const local = localsByMethod.get(method)?.get(name);
  if (local) return local;
  const field = fieldsByOwner.get(method.owner.binaryName)?.get(name);
  if (field) return field;
  return undefined;
}

function inferExpressionType(
  expr: Parser.SyntaxNode,
  caller: MethodInfo,
  ctx: FileContext,
  types: Map<string, TypeInfo>,
  fieldsByOwner: Map<string, Map<string, JavaType>>,
  localsByMethod: Map<MethodInfo, Map<string, JavaType>>,
): JavaType | undefined {
  if (expr.type === "decimal_integer_literal" || expr.type === "hex_integer_literal") {
    return { display: "int" };
  }
  if (expr.type === "string_literal") return { display: "String", binaryName: "java.lang.String" };
  if (expr.type === "true" || expr.type === "false") return { display: "boolean" };
  if (expr.type === "identifier")
    return variableType(expr.text, caller, fieldsByOwner, localsByMethod);
  if (expr.type === "field_access") {
    return fieldAccessType(expr, caller, ctx, types, fieldsByOwner, localsByMethod);
  }
  if (expr.type === "object_creation_expression") {
    const created = javaTypeFromNode(expr.childForFieldName("type"), ctx, types);
    if (created) return created;
  }
  return undefined;
}

function resolveMethod(
  receiver: TypeInfo,
  name: string,
  args: (JavaType | undefined)[],
  byOwnerName: Map<string, MethodInfo[]>,
): MethodInfo | undefined {
  const candidates = byOwnerName.get(`${receiver.binaryName}#${name}`) ?? [];
  const matches = candidates.filter(
    (candidate) =>
      candidate.params.length === args.length &&
      candidate.params.every((param, i) => typeMatches(param.type, args[i])),
  );
  if (matches.length === 1) return matches[0];

  const arityMatches = candidates.filter((candidate) => candidate.params.length === args.length);
  return arityMatches.length === 1 ? arityMatches[0] : undefined;
}

function typeMatches(param: JavaType, arg: JavaType | undefined): boolean {
  if (!arg) return false;
  if (param.binaryName && arg.binaryName) return param.binaryName === arg.binaryName;
  return param.display === arg.display;
}

function* eachOfType(node: Parser.SyntaxNode, type: string): Generator<Parser.SyntaxNode> {
  if (node.type === type) yield node;
  for (const child of node.namedChildren) yield* eachOfType(child, type);
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

function addEdge(edges: GraphEdge[], keys: Set<string>, edge: GraphEdge): void {
  const key = edgeKey(edge);
  if (keys.has(key)) return;
  keys.add(key);
  edges.push(edge);
}

function edgeKey(edge: GraphEdge): string {
  return JSON.stringify([edge.from, edge.to, edge.kind]);
}

function lastSegment(name: string): string {
  return name.split(".").pop() ?? name;
}

function nodeKey(file: string, node: Parser.SyntaxNode): string {
  return `${file}:${node.startPosition.row}:${node.startPosition.column}:${node.endPosition.row}:${node.endPosition.column}`;
}
