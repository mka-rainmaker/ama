// Fixture for higher-order callback attribution (ama-hft.15): a named function
// passed to a higher-order method is invoked by it — a heuristic Calls edge.
export function transform(x: number): number {
  return x * 2;
}

export function handler(): void {}

export function run(xs: number[]): number[] {
  return xs.map(transform);
}

export function go(p: Promise<void>): void {
  p.then(handler);
}
