// Fixture for decorator usage edges: a class decorator and a method decorator
// should each produce a UsesType edge from the decorated symbol to the decorator
// — and NOT a spurious Calls edge for the call-form method decorator.

// biome-ignore lint/suspicious/noExplicitAny: minimal decorator stubs for the fixture
export function sealed(target: any): void {
  void target;
}

export function log(): MethodDecorator {
  return () => {};
}

@sealed
export class Widget {
  @log()
  render(): string {
    return "w";
  }
}
