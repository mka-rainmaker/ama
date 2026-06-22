import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BaselineAnalyzer } from "../../../src/analyzers/baseline/analyzer.js";
import { cSpec } from "../../../src/analyzers/baseline/c.js";
import { csharpSpec } from "../../../src/analyzers/baseline/csharp.js";
import { goSpec } from "../../../src/analyzers/baseline/go.js";
import { javaSpec } from "../../../src/analyzers/baseline/java.js";
import { javascriptSpec } from "../../../src/analyzers/baseline/javascript.js";
import { kotlinSpec } from "../../../src/analyzers/baseline/kotlin.js";
import { phpSpec } from "../../../src/analyzers/baseline/php.js";
import { pythonSpec } from "../../../src/analyzers/baseline/python.js";
import { rustSpec } from "../../../src/analyzers/baseline/rust.js";
import { fileId } from "../../../src/graph/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../fixtures/py-imports");
const jsRoot = path.resolve(here, "../../fixtures/js-imports");
const rsRoot = path.resolve(here, "../../fixtures/rs-imports");
const javaRoot = path.resolve(here, "../../fixtures/java-imports");
const goRoot = path.resolve(here, "../../fixtures/go-imports");
const phpRoot = path.resolve(here, "../../fixtures/php-imports");
const csharpRoot = path.resolve(here, "../../fixtures/csharp-imports");
const csCsprojRoot = path.resolve(here, "../../fixtures/cs-csproj");
const cRoot = path.resolve(here, "../../fixtures/c-imports");
const kotlinRoot = path.resolve(here, "../../fixtures/kotlin-imports");

/**
 * Baseline analyzers emit only File/symbol nodes today, so the import graph is
 * empty for every baseline language. Python relative imports resolve to a file
 * by path alone (no cross-file analysis), so the baseline tier can emit File→File
 * Imports edges — making find_importers / circular_imports work for Python. A
 * package/absolute import (`import os`) is external and emits nothing. (ama-8nr)
 */
describe("baseline Python import edges (ama-8nr)", () => {
  it("emits File→File Imports for relative imports, skipping absolute ones", async () => {
    const result = await new BaselineAnalyzer(pythonSpec).analyze(root, [
      "main.py",
      "helper.py",
      "pkg/__init__.py",
    ]);
    const imports = result.edges.filter(
      (e) => e.kind === "Imports" && e.from === fileId("main.py"),
    );
    // `from . import helper` → helper.py
    expect(imports.some((e) => e.to === fileId("helper.py"))).toBe(true);
    // `from .pkg import thing` → the pkg package's __init__.py
    expect(imports.some((e) => e.to === fileId("pkg/__init__.py"))).toBe(true);
    // `import os` is absolute/external — no edge to a node we can't back
    expect(imports.length).toBe(2);
  });
});

describe("baseline JavaScript import edges (ama-2dn)", () => {
  it("resolves relative import/export/require specifiers, skipping packages", async () => {
    const result = await new BaselineAnalyzer(javascriptSpec).analyze(jsRoot, [
      "main.js",
      "helper.js",
      "util.js",
      "cjs.cjs",
    ]);
    const imports = result.edges.filter(
      (e) => e.kind === "Imports" && e.from === fileId("main.js"),
    );
    // explicit extension, extensionless (try .js), and a require() call
    expect(imports.some((e) => e.to === fileId("helper.js"))).toBe(true);
    expect(imports.some((e) => e.to === fileId("util.js"))).toBe(true);
    expect(imports.some((e) => e.to === fileId("cjs.cjs"))).toBe(true);
    // `left-pad` is a bare package specifier — external, no edge
    expect(imports.length).toBe(3);
  });
});

describe("baseline Rust `mod` import edges (ama-90x)", () => {
  it("wires a file module to its file, honoring the foo.rs-owns-foo/ rule", async () => {
    const result = await new BaselineAnalyzer(rustSpec).analyze(rsRoot, [
      "lib.rs",
      "helper.rs",
      "sub.rs",
      "sub/deep.rs",
    ]);
    const from = (f: string) =>
      result.edges.filter((e) => e.kind === "Imports" && e.from === fileId(f));
    // crate root: `mod helper;` → helper.rs, `pub mod sub;` → sub.rs (same dir)
    expect(from("lib.rs").some((e) => e.to === fileId("helper.rs"))).toBe(true);
    expect(from("lib.rs").some((e) => e.to === fileId("sub.rs"))).toBe(true);
    // a non-mod.rs file owns a subdir: sub.rs's `mod deep;` → sub/deep.rs
    expect(from("sub.rs").some((e) => e.to === fileId("sub/deep.rs"))).toBe(true);
    // `use std::fmt;` is external — no edge (only `mod` declarations wire files)
    expect(from("lib.rs").length).toBe(2);
  });
});

describe("baseline Java import edges (ama-bsj)", () => {
  it("resolves a package import to its file under the source root", async () => {
    const result = await new BaselineAnalyzer(javaSpec).analyze(javaRoot, [
      "src/main/java/com/app/Main.java",
      "src/main/java/com/example/Foo.java",
      "src/main/java/com/util/Helper.java",
    ]);
    const main = fileId("src/main/java/com/app/Main.java");
    const imports = result.edges.filter((e) => e.kind === "Imports" && e.from === main);
    // `import com.example.Foo;` → the source root (src/main/java) is found by scan
    expect(imports.some((e) => e.to === fileId("src/main/java/com/example/Foo.java"))).toBe(true);
    // `import static com.util.Helper.doIt;` → the class file (member dropped)
    expect(imports.some((e) => e.to === fileId("src/main/java/com/util/Helper.java"))).toBe(true);
    // `import java.util.List;` is the JDK — no file in the repo, no edge
    expect(imports.length).toBe(2);
  });

  it("resolves on a single-file batch (incremental reindex is drift-free)", async () => {
    // reindexFile analyzes one file at a time, so the import targets are NOT in the
    // batch. The ancestor scan reads disk (existsSync), not the batch, so the edges
    // still resolve — where file-set suffix-matching would have dropped them.
    const result = await new BaselineAnalyzer(javaSpec).analyze(javaRoot, [
      "src/main/java/com/app/Main.java",
    ]);
    const imports = result.edges.filter((e) => e.kind === "Imports");
    expect(imports.some((e) => e.to === fileId("src/main/java/com/example/Foo.java"))).toBe(true);
    expect(imports.some((e) => e.to === fileId("src/main/java/com/util/Helper.java"))).toBe(true);
  });
});

describe("baseline Go import edges (ama-9yu)", () => {
  it("links a local package import to every .go file in its directory", async () => {
    const result = await new BaselineAnalyzer(goSpec).analyze(goRoot, [
      "main.go",
      "internal/store/store.go",
      "internal/store/helper.go",
    ]);
    const imports = result.edges.filter(
      (e) => e.kind === "Imports" && e.from === fileId("main.go"),
    );
    // `import "example.com/app/internal/store"` → the package's directory, so every
    // (non-test) .go file in it. The go.mod module prefix is stripped to find the dir.
    expect(imports.some((e) => e.to === fileId("internal/store/store.go"))).toBe(true);
    expect(imports.some((e) => e.to === fileId("internal/store/helper.go"))).toBe(true);
    // `import "fmt"` is stdlib — doesn't match the module, so no edge
    expect(imports.length).toBe(2);
  });
});

describe("baseline PHP import edges (ama-x96)", () => {
  it("resolves a PSR-4 `use` to its class file via composer.json", async () => {
    const result = await new BaselineAnalyzer(phpSpec).analyze(phpRoot, [
      "src/Main.php",
      "src/Models/User.php",
    ]);
    const imports = result.edges.filter(
      (e) => e.kind === "Imports" && e.from === fileId("src/Main.php"),
    );
    // `use App\Models\User;` — composer maps "App\\" → "src/", so the FQN resolves
    // to src/Models/User.php (the longest matching PSR-4 prefix is stripped).
    expect(imports.some((e) => e.to === fileId("src/Models/User.php"))).toBe(true);
    expect(imports.length).toBe(1);
  });
});

describe("baseline C# import edges (ama-7e3)", () => {
  it("resolves a `using` to the namespace's source files (package = directory)", async () => {
    const result = await new BaselineAnalyzer(csharpSpec).analyze(csharpRoot, [
      "App/Program.cs",
      "App/Models/User.cs",
    ]);
    const imports = result.edges.filter(
      (e) => e.kind === "Imports" && e.from === fileId("App/Program.cs"),
    );
    // `using App.Models;` — the namespace maps to App/Models/, so the using links to
    // every .cs file there (here, User.cs). The "App" root segment is rebased away by
    // the ancestor + suffix scan.
    expect(imports.some((e) => e.to === fileId("App/Models/User.cs"))).toBe(true);
    expect(imports.length).toBe(1);
  });
});

describe("baseline C# .csproj RootNamespace precision (ama-66z)", () => {
  it("maps a namespace under the project's RootNamespace to its exact directory", async () => {
    const result = await new BaselineAnalyzer(csharpSpec).analyze(csCsprojRoot, [
      "Deep/Page.cs",
      "Sub/Real.cs",
      "Deep/Sub/Wrong.cs",
    ]);
    const imports = result.edges.filter(
      (e) => e.kind === "Imports" && e.from === fileId("Deep/Page.cs"),
    );
    // `using App.Sub;` with <RootNamespace>App</RootNamespace> maps App.Sub exactly to
    // Sub/ (project root + "Sub"), NOT the coincidental Deep/Sub/ a closer suffix scan
    // from Deep/Page.cs would hit first.
    expect(imports.some((e) => e.to === fileId("Sub/Real.cs"))).toBe(true);
    expect(imports.some((e) => e.to === fileId("Deep/Sub/Wrong.cs"))).toBe(false);
  });
});

describe("baseline C/C++ import edges (ama-ftg)", () => {
  it("resolves a quoted #include relative to the file, skipping system headers", async () => {
    const result = await new BaselineAnalyzer(cSpec).analyze(cRoot, ["main.c", "util.h"]);
    const imports = result.edges.filter((e) => e.kind === "Imports" && e.from === fileId("main.c"));
    // `#include "util.h"` → util.h; `#include <stdio.h>` is a system header → no edge.
    expect(imports.some((e) => e.to === fileId("util.h"))).toBe(true);
    expect(imports.length).toBe(1);
  });
});

describe("baseline Kotlin import edges (ama-e23)", () => {
  it("links an import to every .kt file in the package directory (package = dir)", async () => {
    const k = (f: string) => `src/main/kotlin/${f}`;
    const result = await new BaselineAnalyzer(kotlinSpec).analyze(kotlinRoot, [
      k("com/app/Main.kt"),
      k("com/example/Foo.kt"),
      k("com/example/Bar.kt"),
    ]);
    const imports = result.edges.filter(
      (e) => e.kind === "Imports" && e.from === fileId(k("com/app/Main.kt")),
    );
    // `import com.example.Foo` → the package dir com/example (under the source root),
    // so every .kt file there — Foo.kt and its sibling Bar.kt — since the class isn't
    // tied to a filename. The "Foo" symbol segment is dropped to find the package.
    expect(imports.some((e) => e.to === fileId(k("com/example/Foo.kt")))).toBe(true);
    expect(imports.some((e) => e.to === fileId(k("com/example/Bar.kt")))).toBe(true);
    expect(imports.length).toBe(2);
  });
});
