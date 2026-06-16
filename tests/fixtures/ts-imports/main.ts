// Imported via the barrel, not directly — must still resolve to lib.ts.
import { greet } from "./barrel.js";
import { Widget } from "./lib.js";
import makeDefault from "./lib.js";

export function useThem(): void {
  new Widget();
  makeDefault();
  greet();
}
