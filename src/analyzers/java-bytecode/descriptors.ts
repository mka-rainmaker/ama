export interface ParsedMethodDescriptor {
  params: JavaDescriptorType[];
  returnType?: JavaDescriptorType;
}

export interface JavaDescriptorType {
  display: string;
  binaryName?: string;
}

export function parseMethodDescriptor(descriptor: string): ParsedMethodDescriptor {
  let i = 0;
  if (descriptor[i] !== "(") return { params: [] };
  i++;
  const params: JavaDescriptorType[] = [];
  while (i < descriptor.length && descriptor[i] !== ")") {
    const parsed = parseType(descriptor, i);
    params.push(parsed.type);
    i = parsed.next;
  }
  i++; // ')'
  const ret = parseType(descriptor, i);
  return { params, ...(ret.type.display !== "void" ? { returnType: ret.type } : {}) };
}

function parseType(descriptor: string, start: number): { type: JavaDescriptorType; next: number } {
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
