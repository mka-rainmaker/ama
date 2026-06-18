// Fixture for resolution-coverage counting (ama-m8k.12): main has two call sites
// — one internal (resolves to a node) and one external (console.log, no node) —
// so callsTotal=2, callsResolved=1.
export function helper(): number {
  return 1;
}

export function main(): void {
  helper();
  console.log("x");
}
