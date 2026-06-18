// A *type-only* import cycle (ama-bhf): c.ts and d.ts import each other with
// `import type`, which is erased at runtime — so circular_imports (runtime
// cycles) must NOT report {c.ts, d.ts}, even though the file-level type
// dependency forms a loop.
import type { D } from "./d.js";

export interface C {
  d?: D;
}
