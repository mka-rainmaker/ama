// Fixture for UsesType edge resolution. Every referenced type is declared in
// this same file so it resolves to a node; primitive and library types must
// resolve to nothing and therefore emit no edge.

export interface Widget {
  id: number;
}

export class Gadget {
  serial = "";
}

// Function: a parameter type and a return type, both attributed to the function.
export function build(w: Widget): Gadget {
  void w;
  return new Gadget();
}

// Method: parameter + return type, attributed to the method node (not the class).
export class Factory {
  make(spec: Widget): Gadget {
    void spec;
    return new Gadget();
  }
}

// Property: attributed to the enclosing class, since properties are not yet nodes.
export class Holder {
  item: Widget = { id: 0 };
}

// Composite annotation: the reference nested inside `Widget[]` is still found.
export function many(items: Widget[]): void {
  void items;
}

// Purely primitive signature: must not produce any UsesType edge.
export function plain(count: number): string {
  return String(count);
}
