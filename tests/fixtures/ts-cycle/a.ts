// Half of a deliberate import cycle (ama-m8k.7): a.ts imports b.ts and b.ts
// imports a.ts, so file-level cycle detection must report {a.ts, b.ts}.
import { b } from "./b.js";

export function a(): number {
  return b();
}
