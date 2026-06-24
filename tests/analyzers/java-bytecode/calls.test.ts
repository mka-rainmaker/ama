import { describe, expect, it } from "vitest";
import { parseClassFile } from "../../../src/analyzers/java-bytecode/classfile.js";

/**
 * Deep-tier (#15): the bytecode reader extracts RESOLVED method calls from each method's Code
 * attribute — the `invoke*` operand is a fully-qualified Methodref in the constant pool, so a call's
 * owner/name/descriptor are the compiler's resolved truth, no JVM and no source needed.
 *
 * This in-test encoder builds `class com/app/A extends Object { void run(){ help(); } void help(){} }`
 * where run()'s Code is `aload_0; invokevirtual #Methodref(A.help:()V); return`. Independent of the
 * parser, so a round-trip is a real test.
 */
function encodeClassWithCall(): Uint8Array {
  return encodeClassWithRunCode([0x2a, 0xb6, 0x00, 0x0a, 0xb1]);
}

function encodeClassWithRunCode(runCode: number[]): Uint8Array {
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

  u4(0xcafebabe);
  u2(0);
  u2(52); // Java 8

  // Constant pool (indices 1..10) — count = 11.
  u2(11);
  utf8("com/app/A"); //          #1 Utf8
  u1(7); // Class #2 -> #1
  u2(1);
  utf8("java/lang/Object"); //   #3 Utf8
  u1(7); // Class #4 -> #3
  u2(3);
  utf8("run"); //                #5 Utf8
  utf8("()V"); //                #6 Utf8
  utf8("help"); //               #7 Utf8
  utf8("Code"); //               #8 Utf8
  u1(12); // NameAndType #9 -> name #7 (help), descriptor #6 (()V)
  u2(7);
  u2(6);
  u1(10); // Methodref #10 -> class #2 (A), nameAndType #9 (help:()V)
  u2(2);
  u2(9);

  u2(0x0021); // access_flags ACC_PUBLIC | ACC_SUPER
  u2(2); // this_class #2 (A)
  u2(4); // super_class #4 (Object)
  u2(0); // interfaces_count

  u2(0); // fields_count
  u2(2); // methods_count

  // method run() — Code: aload_0(0x2a), invokevirtual(0xb6) #10, return(0xb1)
  u2(0x0000); // access_flags
  u2(5); // name_index "run"
  u2(6); // descriptor_index "()V"
  u2(1); // attributes_count
  u2(8); // attribute name "Code"
  u4(12 + runCode.length); // attribute_length = 2+2+4+code_length+2+2
  u2(1); // max_stack
  u2(1); // max_locals
  u4(runCode.length); // code_length
  for (const b of runCode) u1(b);
  u2(0); // exception_table_length
  u2(0); // attributes_count (of Code)

  // method help() — Code: return(0xb1)
  u2(0x0000);
  u2(7); // name_index "help"
  u2(6); // descriptor_index "()V"
  u2(1);
  u2(8); // "Code"
  u4(13); // 2+2+4+1+2+2
  u2(0); // max_stack
  u2(1); // max_locals
  u4(1); // code_length
  u1(0xb1); // return
  u2(0);
  u2(0);

  u2(0); // class attributes_count
  return new Uint8Array(bytes);
}

describe("bytecode method-body call extraction (deep tier #15)", () => {
  it("extracts a resolved Methodref call from a method's Code attribute", () => {
    const cf = parseClassFile(encodeClassWithCall());
    const run = cf.methods.find((m) => m.name === "run");
    expect(run).toBeDefined();
    expect(run?.calls).toContainEqual({ owner: "com.app.A", name: "help", descriptor: "()V" });
    const help = cf.methods.find((m) => m.name === "help");
    expect(help?.calls).toEqual([]);
  });

  it("does not read past a truncated invoke operand", () => {
    const cf = parseClassFile(encodeClassWithRunCode([0xb6]));
    const run = cf.methods.find((m) => m.name === "run");
    expect(run?.calls).toEqual([]);
  });
});
