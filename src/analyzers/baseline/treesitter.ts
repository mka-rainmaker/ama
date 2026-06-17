import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import Parser from "web-tree-sitter";

const require = createRequire(import.meta.url);

/**
 * Languages we ship a prebuilt tree-sitter grammar for (via `tree-sitter-wasms`),
 * mapped to the grammar's wasm filename. Grow this as baseline analyzers land.
 *
 * The runtime (`web-tree-sitter`) is pinned to match the grammar bundle's ABI:
 * `tree-sitter-wasms@0.1.13` grammars are built with tree-sitter 0.20.x, so the
 * runtime must be `web-tree-sitter@0.20.x` — a newer runtime fails to load them.
 */
const GRAMMARS: Record<string, string> = {
  python: "tree-sitter-python.wasm",
  javascript: "tree-sitter-javascript.wasm",
  java: "tree-sitter-java.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
};

/** Runtime init is one-shot; each grammar is loaded once and cached. */
let runtime: Promise<void> | undefined;
const grammars = new Map<string, Promise<Parser.Language>>();

/** Absolute path to a file bundled inside an installed package. */
function packageFile(pkg: string, ...rel: string[]): string {
  return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), ...rel);
}

function initRuntime(): Promise<void> {
  // Point Emscripten at the runtime wasm explicitly so init works regardless of
  // the process cwd (vitest, the dev loop, an installed CLI).
  runtime ??= Parser.init({ locateFile: () => packageFile("web-tree-sitter", "tree-sitter.wasm") });
  return runtime;
}

/** Load a grammar on demand, caching the (async) result per language. */
function loadLanguage(language: string): Promise<Parser.Language> {
  const file = GRAMMARS[language];
  if (!file) {
    return Promise.reject(new Error(`No bundled tree-sitter grammar for language: ${language}`));
  }
  let pending = grammars.get(language);
  if (!pending) {
    pending = initRuntime().then(() =>
      Parser.Language.load(fs.readFileSync(packageFile("tree-sitter-wasms", "out", file))),
    );
    grammars.set(language, pending);
  }
  return pending;
}

/**
 * Parse source code in `language` into a tree-sitter CST, loading (and caching)
 * the grammar on first use. Rejects for a language with no bundled grammar.
 */
export async function parse(language: string, code: string): Promise<Parser.Tree> {
  const lang = await loadLanguage(language);
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser.parse(code);
}

/** Languages that have a bundled grammar (so a baseline analyzer can claim them). */
export function supportedLanguages(): string[] {
  return Object.keys(GRAMMARS);
}
