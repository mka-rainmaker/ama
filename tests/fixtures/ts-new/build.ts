// Fixture for new-expression Calls edges: `make` constructs Widget, so it
// should get a Calls edge to Widget (construction is a call site).
export class Widget {}

export function make(): Widget {
  return new Widget();
}
