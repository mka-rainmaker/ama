import * as fs from "node:fs";
import * as path from "node:path";
import type Parser from "web-tree-sitter";
import type { LanguageSpec } from "./analyzer.js";

/** Cache: an importer's directory (absolute) → the nearest composer.json's repo-
 *  relative directory and its PSR-4 `[prefix, baseDir]` autoload map, or null. */
const composerCache = new Map<string, { dir: string; psr4: [string, string][] } | null>();

function parentDir(rel: string): string {
  const p = path.posix.dirname(rel);
  return p === "." ? "" : p;
}

/** The nearest composer.json at or above `dirRel`, with its directory and parsed
 *  PSR-4 prefix→directory map — so a `use` resolves whether the index root *is* the
 *  package or merely contains it (a monorepo / Ama's own fixture). (ama-x96) */
function nearestComposer(
  root: string,
  dirRel: string,
): { dir: string; psr4: [string, string][] } | null {
  const absDir = path.join(root, dirRel);
  const cached = composerCache.get(absDir);
  if (cached !== undefined) return cached;
  let result: { dir: string; psr4: [string, string][] } | null = null;
  try {
    const json = JSON.parse(fs.readFileSync(path.join(absDir, "composer.json"), "utf8"));
    const map = json?.autoload?.["psr-4"];
    if (map && typeof map === "object") {
      const psr4: [string, string][] = [];
      for (const [prefix, base] of Object.entries(map)) {
        const dir = Array.isArray(base) ? base[0] : base; // a prefix may map to one dir or a list
        if (typeof dir === "string") psr4.push([prefix, dir.replace(/\/+$/, "")]);
      }
      result = { dir: dirRel, psr4 };
    }
  } catch {
    result = null; // no/invalid composer.json — try the parent below
  }
  if (!result && dirRel !== "" && dirRel !== ".") {
    result = nearestComposer(root, parentDir(dirRel));
  }
  composerCache.set(absDir, result);
  return result;
}

/** Resolve a PHP `use Vendor\Pkg\Klass;` to its class file via PSR-4. The class is
 *  the whole fully-qualified name (one class = one file); the namespace→directory
 *  mapping lives in composer.json's `autoload.psr-4`, so strip the longest matching
 *  prefix and map the rest to a path under its base directory. A `use` whose
 *  namespace matches no PSR-4 prefix (a third-party/global class) resolves to
 *  nothing. (ama-x96) */
function phpImports(
  node: Parser.SyntaxNode,
  importerRel: string,
  root: string,
): string[][] | undefined {
  if (node.type !== "namespace_use_clause") return undefined;
  const qn = node.namedChildren.find((c) => c.type === "qualified_name");
  if (!qn) return [];
  const fqn = qn.text.replace(/^\\/, ""); // a leading `\` just marks the FQN as absolute
  const composer = nearestComposer(root, parentDir(importerRel));
  if (!composer) return [];
  let best: { prefix: string; base: string } | undefined;
  for (const [prefix, base] of composer.psr4) {
    if (fqn.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, base };
    }
  }
  if (!best) return [];
  const relPath = fqn.slice(best.prefix.length).replace(/\\/g, "/");
  const file = [composer.dir, best.base, `${relPath}.php`].filter(Boolean).join("/");
  return [[file]];
}

/**
 * Baseline (syntactic) spec for PHP. Each top-level construct has its own CST
 * node type — class/interface/trait/enum declarations, free functions, and
 * methods inside a class body — so each maps directly to a graph kind, and
 * methods qualify under their type (e.g. `Sample.square`). A trait is a set of
 * reusable method implementations, so it's modelled as a Class (the closest
 * kind); there's no dedicated Trait kind.
 */
export const phpSpec: LanguageSpec = {
  language: "php",
  extensions: [".php"],
  grammar: "php",
  symbols: {
    class_declaration: { kind: "Class" },
    interface_declaration: { kind: "Interface" },
    trait_declaration: { kind: "Class" },
    enum_declaration: { kind: "Enum" },
    function_definition: { kind: "Function" },
    method_declaration: { kind: "Method" },
  },
  resolveImports: phpImports,
};
