// The other half of the type-only cycle (ama-bhf): d.ts type-imports c.ts.
import type { C } from "./c.js";

export interface D {
  c?: C;
}
