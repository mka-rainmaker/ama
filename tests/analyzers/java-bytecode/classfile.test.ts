import { describe, expect, it } from "vitest";
import {
  type ClassFileData,
  parseClassFile,
} from "../../../src/analyzers/java-bytecode/classfile.js";

/**
 * In-test class-file encoder: emits spec-correct .class bytes for test fixtures.
 * Encodes a minimal class file with the given metadata.
 * Used to avoid JDK dependency while testing the parser.
 */
class ClassFileEncoder {
  private bytes: number[] = [];

  private u1(val: number): void {
    this.bytes.push(val & 0xff);
  }

  private u2(val: number): void {
    this.bytes.push((val >> 8) & 0xff);
    this.bytes.push(val & 0xff);
  }

  private u4(val: number): void {
    this.bytes.push((val >> 24) & 0xff);
    this.bytes.push((val >> 16) & 0xff);
    this.bytes.push((val >> 8) & 0xff);
    this.bytes.push(val & 0xff);
  }

  private addUtf8(index: number, str: string): void {
    const encoded = new TextEncoder().encode(str);
    this.u1(1); // CONSTANT_Utf8 tag
    this.u2(encoded.length);
    for (const byte of encoded) {
      this.u1(byte);
    }
  }

  private addClass(index: number, utfIndex: number): void {
    this.u1(7); // CONSTANT_Class tag
    this.u2(utfIndex);
  }

  /**
   * Encode a minimal .class file for the given class.
   * params: { thisClass, superClass, interfaces, isInterface, accessFlags? }
   */
  encode(params: {
    thisClass: string;
    superClass?: string;
    interfaces?: string[];
    isInterface?: boolean;
    accessFlags?: number;
  }): Uint8Array {
    const interfaces = params.interfaces ?? [];
    const isInterface = params.isInterface ?? false;
    const accessFlags = params.accessFlags ?? (isInterface ? 0x0600 : 0x0001); // ACC_PUBLIC

    // Constant pool:
    // Index 0: unused
    // Index 1: CONSTANT_Utf8 for this class internal name
    // Index 2: CONSTANT_Class pointing to 1
    // Index 3: CONSTANT_Utf8 for superclass internal name (if needed)
    // Index 4: CONSTANT_Class pointing to 3 (if needed)
    // Index 5+: interfaces (pairs of Utf8 + Class)
    // For a Long before the main entries (to test two-slot skip):
    //   Index X: CONSTANT_Long tag 5 (occupies X and X+1)
    //   Index X+1: implicit (part of Long)

    this.bytes = [];

    // Magic and version
    this.u4(0xcafebabe);
    this.u2(0); // minor_version
    this.u2(52); // major_version (Java 8)

    // Constant pool: count includes 1 (the unused entry 0)
    const thisInternal = params.thisClass.replace(/\./g, "/");
    const superInternal = params.superClass?.replace(/\./g, "/") ?? "java/lang/Object";

    // Index 1: thisClass UTF8
    let cpIndex = 1;
    const thisUtfIndex = cpIndex;
    cpIndex++;

    // Index 2: thisClass Class
    const thisClassIndex = cpIndex;
    cpIndex++;

    // Index 3: superClass UTF8
    const superUtfIndex = cpIndex;
    cpIndex++;

    // Index 4: superClass Class
    const superClassIndex = cpIndex;
    cpIndex++;

    // Interfaces: each needs a UTF8 (even index) + Class (odd index)
    const ifaceIndices: number[] = [];
    for (const iface of interfaces) {
      const ifaceUtfIndex = cpIndex;
      cpIndex++;
      const ifaceClassIndex = cpIndex;
      cpIndex++;
      ifaceIndices.push(ifaceClassIndex);
    }

    // Total CP count (1-based, so count = cpIndex)
    const constantPoolCount = cpIndex;

    // Emit constant pool
    this.u2(constantPoolCount);

    // Index 1: thisClass UTF8
    this.addUtf8(thisUtfIndex, thisInternal);

    // Index 2: thisClass Class
    this.addClass(thisClassIndex, thisUtfIndex);

    // Index 3: superClass UTF8
    this.addUtf8(superUtfIndex, superInternal);

    // Index 4: superClass Class
    this.addClass(superClassIndex, superUtfIndex);

    // Interface UTF8s and Classes
    for (let i = 0; i < interfaces.length; i++) {
      const ifaceInternal = interfaces[i].replace(/\./g, "/");
      const ifaceUtfIndex = 5 + i * 2; // Assuming indices are sequential
      const ifaceClassIndex = 5 + i * 2 + 1;
      this.addUtf8(ifaceUtfIndex, ifaceInternal);
      this.addClass(ifaceClassIndex, ifaceUtfIndex);
    }

    // Access flags
    this.u2(accessFlags);

    // this_class
    this.u2(thisClassIndex);

    // super_class (0 if none, otherwise superClassIndex)
    this.u2(params.superClass ? superClassIndex : 0);

    // interfaces_count and interfaces
    this.u2(interfaces.length);
    for (const ifaceIdx of ifaceIndices) {
      this.u2(ifaceIdx);
    }

    // fields_count, methods_count, attributes_count (all 0 for minimal)
    this.u2(0);
    this.u2(0);
    this.u2(0);

    return new Uint8Array(this.bytes);
  }
}

describe("parseClassFile: JVM class-file parser", () => {
  it("parses a simple class with superclass", () => {
    const encoder = new ClassFileEncoder();
    const bytes = encoder.encode({
      thisClass: "com.app.Sub",
      superClass: "com.app.Base",
    });

    const result = parseClassFile(bytes);
    expect(result.thisClass).toBe("com.app.Sub");
    expect(result.superClass).toBe("com.app.Base");
    expect(result.interfaces).toEqual([]);
    expect(result.isInterface).toBe(false);
  });

  it("parses a class implementing one interface", () => {
    const encoder = new ClassFileEncoder();
    const bytes = encoder.encode({
      thisClass: "com.app.Sub",
      superClass: "com.app.Base",
      interfaces: ["com.app.Iface"],
    });

    const result = parseClassFile(bytes);
    expect(result.thisClass).toBe("com.app.Sub");
    expect(result.superClass).toBe("com.app.Base");
    expect(result.interfaces).toEqual(["com.app.Iface"]);
    expect(result.isInterface).toBe(false);
  });

  it("omits java.lang.Object as superClass", () => {
    const encoder = new ClassFileEncoder();
    const bytes = encoder.encode({
      thisClass: "com.app.Plain",
      superClass: "java.lang.Object",
    });

    const result = parseClassFile(bytes);
    expect(result.thisClass).toBe("com.app.Plain");
    expect(result.superClass).toBeUndefined();
  });

  it("detects interface flag (ACC_INTERFACE)", () => {
    const encoder = new ClassFileEncoder();
    const bytes = encoder.encode({
      thisClass: "com.app.MyInterface",
      isInterface: true,
      accessFlags: 0x0600, // ACC_INTERFACE | ACC_PUBLIC
    });

    const result = parseClassFile(bytes);
    expect(result.isInterface).toBe(true);
  });

  it("throws on invalid magic number", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x34]);
    expect(() => parseClassFile(bytes)).toThrow(/Invalid class file magic/);
  });

  it("parses a class with multiple interfaces", () => {
    const encoder = new ClassFileEncoder();
    const bytes = encoder.encode({
      thisClass: "com.app.MultiImpl",
      superClass: "java.lang.Object",
      interfaces: ["com.app.IfaceA", "com.app.IfaceB"],
    });

    const result = parseClassFile(bytes);
    expect(result.thisClass).toBe("com.app.MultiImpl");
    expect(result.superClass).toBeUndefined(); // Object omitted
    expect(result.interfaces).toEqual(["com.app.IfaceA", "com.app.IfaceB"]);
  });
});
