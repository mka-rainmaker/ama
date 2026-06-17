// Fixture for method override / virtual dispatch over class inheritance: a call
// to a base-class method should fan out to the subclass's override.
export class Base {
  run(): number {
    return 0;
  }
}

export class Derived extends Base {
  run(): number {
    return 1;
  }
}

export function use(b: Base): number {
  return b.run();
}
