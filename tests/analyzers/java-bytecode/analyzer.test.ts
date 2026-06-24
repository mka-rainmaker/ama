import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JavaBytecodeAnalyzer } from "../../../src/analyzers/java-bytecode/analyzer.js";
import { TYPE_REF_PREFIX, fileId, symbolId } from "../../../src/graph/index.js";

/**
 * Minimal, spec-faithful .class encoder (independent of the parser) so the analyzer can be exercised
 * end-to-end against a real file on disk without a JDK. Emits `class <this> extends <super>
 * implements <ifaces...>` with empty fields/methods/attributes.
 */
function encodeClass(p: {
  thisClass: string;
  superClass?: string;
  interfaces?: string[];
  isInterface?: boolean;
}): Uint8Array {
  const interfaces = p.interfaces ?? [];
  const bytes: number[] = [];
  const u1 = (v: number) => bytes.push(v & 0xff);
  const u2 = (v: number) => bytes.push((v >> 8) & 0xff, v & 0xff);
  const u4 = (v: number) =>
    bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  const utf8 = (s: string) => {
    const enc = new TextEncoder().encode(s);
    u1(1);
    u2(enc.length);
    for (const b of enc) u1(b);
  };
  const classConst = (utfIndex: number) => {
    u1(7);
    u2(utfIndex);
  };

  u4(0xcafebabe);
  u2(0);
  u2(52); // Java 8

  const superInternal = (p.superClass ?? "java.lang.Object").replace(/\./g, "/");
  // Pool layout: 1=thisUtf 2=thisClass 3=superUtf 4=superClass then per-iface (utf, class)
  let idx = 1;
  const thisUtf = idx++;
  const thisClass = idx++;
  const superUtf = idx++;
  const superClass = idx++;
  const ifaceClassIdx: number[] = [];
  const ifaceUtfIdx: number[] = [];
  for (let i = 0; i < interfaces.length; i++) {
    ifaceUtfIdx.push(idx++);
    ifaceClassIdx.push(idx++);
  }
  u2(idx); // constant_pool_count = last index + 1

  utf8(p.thisClass.replace(/\./g, "/"));
  classConst(thisUtf);
  utf8(superInternal);
  classConst(superUtf);
  for (let i = 0; i < interfaces.length; i++) {
    utf8((interfaces[i] as string).replace(/\./g, "/"));
    classConst(ifaceUtfIdx[i] as number);
  }

  u2(p.isInterface ? 0x0600 : 0x0001); // access_flags (ACC_INTERFACE | ACC_ABSTRACT / ACC_PUBLIC)
  u2(thisClass);
  u2(p.superClass ? superClass : 0);
  u2(interfaces.length);
  for (const ci of ifaceClassIdx) u2(ci);
  u2(0); // fields
  u2(0); // methods
  u2(0); // attributes
  return new Uint8Array(bytes);
}

describe("JavaBytecodeAnalyzer (end-to-end over a real .class file)", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ama-bc-"));
    fs.writeFileSync(
      path.join(root, "Sub.class"),
      encodeClass({
        thisClass: "com.app.Sub",
        superClass: "com.app.Base",
        interfaces: ["com.app.Iface"],
      }),
    );
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("emits a File node and a Class node for the compiled class", () => {
    const { nodes } = new JavaBytecodeAnalyzer().analyze(root, ["Sub.class"]);
    expect(nodes.some((n) => n.id === fileId("Sub.class") && n.kind === "File")).toBe(true);
    const cls = nodes.find((n) => n.id === symbolId({ file: "Sub.class", qualifiedName: "Sub" }));
    expect(cls?.kind).toBe("Class");
    expect(cls?.tier).toBe("baseline");
  });

  it("emits Inherits/Implements edges as type: candidates the resolver relinks", () => {
    const { edges } = new JavaBytecodeAnalyzer().analyze(root, ["Sub.class"]);
    const from = symbolId({ file: "Sub.class", qualifiedName: "Sub" });
    expect(
      edges.some(
        (e) => e.kind === "Inherits" && e.from === from && e.to === `${TYPE_REF_PREFIX}Base`,
      ),
    ).toBe(true);
    expect(
      edges.some(
        (e) => e.kind === "Implements" && e.from === from && e.to === `${TYPE_REF_PREFIX}Iface`,
      ),
    ).toBe(true);
  });

  it("marks an interface .class as an Interface node", () => {
    fs.writeFileSync(
      path.join(root, "It.class"),
      encodeClass({ thisClass: "com.app.It", isInterface: true }),
    );
    const { nodes } = new JavaBytecodeAnalyzer().analyze(root, ["It.class"]);
    const node = nodes.find((n) => n.id === symbolId({ file: "It.class", qualifiedName: "It" }));
    expect(node?.kind).toBe("Interface");
  });
});
