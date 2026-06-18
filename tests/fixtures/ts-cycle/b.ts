// The other half of the cycle: b.ts imports a.ts (used by alsoUsesA), closing
// the a.ts ↔ b.ts import loop.
import { a } from "./a.js";

export function b(): number {
  return 1;
}

export function alsoUsesA(): number {
  return a();
}
