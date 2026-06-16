// Fixture for interface-method dispatch: the interface method is a node, a call
// through an interface-typed value resolves to it, and virtual dispatch fans the
// call out to the implementing class's method.
export interface Service {
  run(): number;
}

export class FastService implements Service {
  run(): number {
    return 1;
  }
}

export function useService(s: Service): number {
  return s.run();
}
