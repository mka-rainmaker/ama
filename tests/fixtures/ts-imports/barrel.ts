// Re-export chain: `greet` originates in lib, surfaced through this barrel.
export { greet } from "./lib.js";
// Star re-export: surfaces lib's whole namespace, so it targets lib.ts's File node.
export * from "./lib.js";
