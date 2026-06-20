import type { Widget } from "./types.js";

export const widget: Widget = { id: "x" };

// untyped object literal — should stay node-less (control)
export const config = { id: "y" };
