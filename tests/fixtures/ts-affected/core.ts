// Fixture for `affected --tests` (ama-5gs.9): core is imported by a source file
// (user.ts) and a test-named file (core.test.ts), so test-impact mode returns
// only the latter.
export function core(): number {
  return 1;
}
