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
  /** Methods declared in the class file, including compiler-generated ones. */
  methods: ClassFileMethod[];
}

export interface ClassFileMethod {
  name: string;
  descriptor: string;
  accessFlags: number;
  calls: ClassFileMethodCall[];
}

export interface ClassFileMethodCall {
  /** Fully qualified owner class in dotted binary-name form, e.g. "com.foo.Bar$Nested". */
  owner: string;
  name: string;
  descriptor: string;
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

  // Skip fields for now; method descriptors and Code attributes are the part needed for deep call
  // resolution. The generic member skipper still consumes field attributes correctly.
  const fieldsCount = view.getUint16(offset, false);
  offset += 2;
  for (let i = 0; i < fieldsCount; i++) {
    offset = skipMemberInfo(view, offset);
  }

  const methodsCount = view.getUint16(offset, false);
  offset += 2;
  const methods: ClassFileMethod[] = [];
  for (let i = 0; i < methodsCount; i++) {
    const parsed = parseMethodInfo(view, offset, constantPool);
    offset = parsed.nextOffset;
    methods.push(parsed.method);
  }

  return { thisClass, superClass, interfaces, isInterface, methods };
}

/**
 * Constant pool entry types. Only tags relevant to class structure are stored;
 * others are skipped by size.
 */
interface ConstantPoolEntry {
  tag: number;
  value?: string; // For Utf8 entries
  classNameIndex?: number; // For Class entries
  referenceClassIndex?: number; // For Fieldref/Methodref/InterfaceMethodref entries
  referenceNameAndTypeIndex?: number;
  nameIndex?: number; // For NameAndType entries
  descriptorIndex?: number;
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
        offset += 2;
        break;

      case 9: // CONSTANT_Fieldref
      case 10: // CONSTANT_Methodref
      case 11: // CONSTANT_InterfaceMethodref
        {
          const referenceClassIndex = view.getUint16(offset, false);
          offset += 2;
          const referenceNameAndTypeIndex = view.getUint16(offset, false);
          offset += 2;
          pool.set(i, { tag, referenceClassIndex, referenceNameAndTypeIndex });
        }
        break;

      case 12: // CONSTANT_NameAndType
        {
          const nameIndex = view.getUint16(offset, false);
          offset += 2;
          const descriptorIndex = view.getUint16(offset, false);
          offset += 2;
          pool.set(i, { tag, nameIndex, descriptorIndex });
        }
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

function utf8(pool: Map<number, ConstantPoolEntry>, index: number): string | undefined {
  const entry = pool.get(index);
  return entry?.tag === 1 ? entry.value : undefined;
}

function skipMemberInfo(view: DataView, startOffset: number): number {
  let offset = startOffset;
  offset += 6; // access_flags, name_index, descriptor_index
  const attributesCount = view.getUint16(offset, false);
  offset += 2;
  for (let i = 0; i < attributesCount; i++) {
    offset += 2; // attribute_name_index
    const attributeLength = view.getUint32(offset, false);
    offset += 4 + attributeLength;
  }
  return offset;
}

function parseMethodInfo(
  view: DataView,
  startOffset: number,
  pool: Map<number, ConstantPoolEntry>,
): { method: ClassFileMethod; nextOffset: number } {
  let offset = startOffset;
  const accessFlags = view.getUint16(offset, false);
  offset += 2;
  const nameIndex = view.getUint16(offset, false);
  offset += 2;
  const descriptorIndex = view.getUint16(offset, false);
  offset += 2;
  const name = utf8(pool, nameIndex) ?? "";
  const descriptor = utf8(pool, descriptorIndex) ?? "";
  const calls: ClassFileMethodCall[] = [];

  const attributesCount = view.getUint16(offset, false);
  offset += 2;
  for (let i = 0; i < attributesCount; i++) {
    const attributeNameIndex = view.getUint16(offset, false);
    offset += 2;
    const attributeLength = view.getUint32(offset, false);
    offset += 4;
    const attributeStart = offset;
    const attributeName = utf8(pool, attributeNameIndex);
    if (attributeName === "Code") {
      calls.push(...parseCodeAttribute(view, attributeStart, pool));
    }
    offset = attributeStart + attributeLength;
  }

  return { method: { name, descriptor, accessFlags, calls }, nextOffset: offset };
}

function parseCodeAttribute(
  view: DataView,
  startOffset: number,
  pool: Map<number, ConstantPoolEntry>,
): ClassFileMethodCall[] {
  let offset = startOffset;
  offset += 2; // max_stack
  offset += 2; // max_locals
  const codeLength = view.getUint32(offset, false);
  offset += 4;
  const codeStart = offset;
  const codeEnd = codeStart + codeLength;
  const calls: ClassFileMethodCall[] = [];
  let pc = codeStart;
  while (pc < codeEnd) {
    const opcode = view.getUint8(pc);
    if ((opcode === 0xb6 || opcode === 0xb7 || opcode === 0xb8) && pc + 3 <= codeEnd) {
      const methodRefIndex = view.getUint16(pc + 1, false);
      const call = resolveMethodRef(pool, methodRefIndex);
      if (call) calls.push(call);
    } else if (opcode === 0xb9 && pc + 5 <= codeEnd) {
      const methodRefIndex = view.getUint16(pc + 1, false);
      const call = resolveMethodRef(pool, methodRefIndex);
      if (call) calls.push(call);
    }
    pc += instructionLength(view, pc, codeStart, codeEnd);
  }
  return calls;
}

function resolveMethodRef(
  pool: Map<number, ConstantPoolEntry>,
  index: number,
): ClassFileMethodCall | undefined {
  const ref = pool.get(index);
  if (!ref || (ref.tag !== 10 && ref.tag !== 11)) return undefined;
  if (ref.referenceClassIndex === undefined || ref.referenceNameAndTypeIndex === undefined) {
    return undefined;
  }
  const ownerInternal = resolveClassName(pool, ref.referenceClassIndex);
  const nat = pool.get(ref.referenceNameAndTypeIndex);
  if (!ownerInternal || !nat || nat.tag !== 12) return undefined;
  if (nat.nameIndex === undefined || nat.descriptorIndex === undefined) return undefined;
  const name = utf8(pool, nat.nameIndex);
  const descriptor = utf8(pool, nat.descriptorIndex);
  if (!name || !descriptor) return undefined;
  return { owner: internalToQualified(ownerInternal), name, descriptor };
}

function instructionLength(view: DataView, pc: number, codeStart: number, codeEnd: number): number {
  const opcode = view.getUint8(pc);
  let length = 1;
  switch (opcode) {
    case 0x10:
    case 0x12:
    case 0x15:
    case 0x16:
    case 0x17:
    case 0x18:
    case 0x19:
    case 0x36:
    case 0x37:
    case 0x38:
    case 0x39:
    case 0x3a:
    case 0xa9:
    case 0xbc:
      length = 2;
      break;
    case 0x11:
    case 0x13:
    case 0x14:
    case 0x84:
    case 0x99:
    case 0x9a:
    case 0x9b:
    case 0x9c:
    case 0x9d:
    case 0x9e:
    case 0x9f:
    case 0xa0:
    case 0xa1:
    case 0xa2:
    case 0xa3:
    case 0xa4:
    case 0xa5:
    case 0xa6:
    case 0xa7:
    case 0xa8:
    case 0xb2:
    case 0xb3:
    case 0xb4:
    case 0xb5:
    case 0xb6:
    case 0xb7:
    case 0xb8:
    case 0xbb:
    case 0xbd:
    case 0xc0:
    case 0xc1:
    case 0xc6:
    case 0xc7:
      length = 3;
      break;
    case 0xb9:
    case 0xba:
    case 0xc8:
    case 0xc9:
      length = 5;
      break;
    case 0xc5:
      length = 4;
      break;
    case 0xc4: {
      if (pc + 2 > codeEnd) return boundedInstructionLength(1, pc, codeEnd);
      const widened = view.getUint8(pc + 1);
      length = widened === 0x84 ? 6 : 4;
      break;
    }
    case 0xaa:
      return tableSwitchLength(view, pc, codeStart, codeEnd);
    case 0xab:
      return lookupSwitchLength(view, pc, codeStart, codeEnd);
    default:
      break;
  }
  return boundedInstructionLength(length, pc, codeEnd);
}

function switchPadding(pc: number, codeStart: number): number {
  const offsetAfterOpcode = pc - codeStart + 1;
  return (4 - (offsetAfterOpcode % 4)) % 4;
}

function tableSwitchLength(view: DataView, pc: number, codeStart: number, codeEnd: number): number {
  const padding = switchPadding(pc, codeStart);
  const payload = pc + 1 + padding;
  const baseLength = 1 + padding + 12;
  if (baseLength > codeEnd - pc) return boundedInstructionLength(baseLength, pc, codeEnd);
  const low = view.getInt32(payload + 4, false);
  const high = view.getInt32(payload + 8, false);
  const entries = high >= low ? high - low + 1 : 0;
  return boundedInstructionLength(baseLength + entries * 4, pc, codeEnd);
}

function lookupSwitchLength(
  view: DataView,
  pc: number,
  codeStart: number,
  codeEnd: number,
): number {
  const padding = switchPadding(pc, codeStart);
  const payload = pc + 1 + padding;
  const baseLength = 1 + padding + 8;
  if (baseLength > codeEnd - pc) return boundedInstructionLength(baseLength, pc, codeEnd);
  const npairs = view.getInt32(payload + 4, false);
  return boundedInstructionLength(baseLength + Math.max(0, npairs) * 8, pc, codeEnd);
}

function boundedInstructionLength(length: number, pc: number, codeEnd: number): number {
  return Math.max(1, Math.min(length, codeEnd - pc));
}
