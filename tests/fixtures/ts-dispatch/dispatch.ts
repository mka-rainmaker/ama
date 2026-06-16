// Fixture for interface-method dispatch: the interface method should be a node,
// and a call through an interface-typed value should resolve to it.
export interface Service {
  run(): number;
}

export function useService(s: Service): number {
  return s.run();
}
