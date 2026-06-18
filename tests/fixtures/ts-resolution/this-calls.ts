// Fixture for the unresolved-grouping refinement (ama-k9t): a builtin method call
// on an instance property. The callee root should be the property ("items"), not
// the opaque "this".
export class Box {
  private items: number[] = [];
  add(x: number): void {
    this.items.push(x);
  }
}
