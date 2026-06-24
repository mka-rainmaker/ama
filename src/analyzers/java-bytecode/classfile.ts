/**
 * Pure-TypeScript reader for the JVM `.class` file format (Java SE 8+) — no JVM required. Parses the
 * header, constant pool, and access flags to extract the resolved type hierarchy (this class,
 * superclass, interfaces) straight from compiled bytecode.
 */

export interface ClassFileData {
  /** Fully qualified class name in dotted form, e.g. "com.foo.Bar". */
  thisClass: string;
  /** Fully qualified superclass name, or undefined if Object or interface. */
  superClass?: string;
  /** Fully qualified interface names. */
  interfaces: string[];
  /** True if ACC_INTERFACE flag is set. */
  isInterface: boolean;
}

/** Parse a JVM class file from bytes. Throws on invalid format. */
export function parseClassFile(bytes: Uint8Array): ClassFileData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  // Read magic number
  const magic = view.getUint32(offset, false);
  offset += 4;
  if (magic !== 0xcafebabe) {
    throw new Error(`Invalid class file magic: 0x${magic.toString(16)}`);
  }

  // Read version
  const minor = view.getUint16(offset, false);
  offset += 2;
  const major = view.getUint16(offset, false);
  offset += 2;
  if (major < 45 || major > 65) {
    // Java 1.1+ (45) through Java 21 (65)
    // Lenient for forward compat
  }

  // Read constant pool count and parse pool
  const constantPoolCount = view.getUint16(offset, false);
  offset += 2;
  const constantPool = new Map<number, ConstantPoolEntry>();
  offset = parseConstantPool(view, offset, constantPoolCount, constantPool);

  // Read access flags
  const accessFlags = view.getUint16(offset, false);
  offset += 2;
  const isInterface = (accessFlags & 0x0200) !== 0; // ACC_INTERFACE

  // Read this class (mandatory)
  const thisClassIndex = view.getUint16(offset, false);
  offset += 2;
  const thisClassName = resolveClassName(constantPool, thisClassIndex);
  if (!thisClassName) {
    throw new Error(`Could not resolve this_class index ${thisClassIndex}`);
  }
  const thisClass = internalToQualified(thisClassName);

  // Read super class (0 if none)
  const superClassIndex = view.getUint16(offset, false);
  offset += 2;
  let superClass: string | undefined;
  if (superClassIndex !== 0) {
    const superClassName = resolveClassName(constantPool, superClassIndex);
    if (superClassName) {
      const qualified = internalToQualified(superClassName);
      // Omit java.lang.Object
      if (qualified !== "java.lang.Object") {
        superClass = qualified;
      }
    }
  }

  // Read interfaces
  const interfacesCount = view.getUint16(offset, false);
  offset += 2;
  const interfaces: string[] = [];
  for (let i = 0; i < interfacesCount; i++) {
    const ifaceIndex = view.getUint16(offset, false);
    offset += 2;
    const ifaceName = resolveClassName(constantPool, ifaceIndex);
    if (ifaceName) {
      interfaces.push(internalToQualified(ifaceName));
    }
  }

  return { thisClass, superClass, interfaces, isInterface };
}

/**
 * Constant pool entry types. Only tags relevant to class structure are stored;
 * others are skipped by size.
 */
interface ConstantPoolEntry {
  tag: number;
  value?: string; // For Utf8 entries
  classNameIndex?: number; // For Class entries
}

/**
 * Parse the constant pool and return the offset after the pool.
 * Stores only Utf8 and Class entries; other entries' positions are tracked
 * to advance the offset correctly (including two-slot entries like Long/Double).
 */
function parseConstantPool(
  view: DataView,
  startOffset: number,
  count: number,
  pool: Map<number, ConstantPoolEntry>,
): number {
  let offset = startOffset;
  // Pool indices are 1-based; 0 is invalid.
  for (let i = 1; i < count; i++) {
    const tag = view.getUint8(offset);
    offset += 1;

    switch (tag) {
      case 1: // CONSTANT_Utf8
        {
          const length = view.getUint16(offset, false);
          offset += 2;
          const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
          offset += length;
          pool.set(i, {
            tag,
            value: new TextDecoder().decode(bytes),
          });
        }
        break;

      case 3: // CONSTANT_Integer
      case 4: // CONSTANT_Float
        offset += 4;
        break;

      case 5: // CONSTANT_Long
      case 6: // CONSTANT_Double
        offset += 8;
        i++; // These occupy TWO pool slots
        break;

      case 7: // CONSTANT_Class
        {
          const nameIndex = view.getUint16(offset, false);
          offset += 2;
          pool.set(i, { tag, classNameIndex: nameIndex });
        }
        break;

      case 8: // CONSTANT_String
        {
          const stringIndex = view.getUint16(offset, false);
          offset += 2;
        }
        break;

      case 9: // CONSTANT_Fieldref
      case 10: // CONSTANT_Methodref
      case 11: // CONSTANT_InterfaceMethodref
        offset += 4; // u2 class_index + u2 name_and_type_index
        break;

      case 12: // CONSTANT_NameAndType
        offset += 4; // u2 name_index + u2 descriptor_index
        break;

      case 15: // CONSTANT_MethodHandle
        offset += 3; // u1 reference_kind + u2 reference_index
        break;

      case 16: // CONSTANT_MethodType
        offset += 2; // u2 descriptor_index
        break;

      case 17: // CONSTANT_Dynamic
      case 18: // CONSTANT_InvokeDynamic
        offset += 4; // u2 bootstrap_method_attr_index + u2 name_and_type_index
        break;

      case 19: // CONSTANT_Module
      case 20: // CONSTANT_Package
        offset += 2; // u2 name_index
        break;

      default:
        throw new Error(`Unknown constant pool tag: ${tag} at index ${i}`);
    }
  }
  return offset;
}

/**
 * Resolve a class name from a CONSTANT_Class pool entry.
 * Returns the internal form (e.g., "com/foo/Bar") or undefined if unresolvable.
 */
function resolveClassName(
  pool: Map<number, ConstantPoolEntry>,
  classIndex: number,
): string | undefined {
  const classEntry = pool.get(classIndex);
  if (!classEntry || classEntry.tag !== 7) return undefined;

  const nameIndex = classEntry.classNameIndex;
  if (nameIndex === undefined) return undefined;

  const nameEntry = pool.get(nameIndex);
  if (!nameEntry || nameEntry.tag !== 1) return undefined;

  return nameEntry.value;
}

/**
 * Convert internal class name ("com/foo/Bar") to qualified form ("com.foo.Bar").
 */
function internalToQualified(internal: string): string {
  return internal.replace(/\//g, ".");
}
