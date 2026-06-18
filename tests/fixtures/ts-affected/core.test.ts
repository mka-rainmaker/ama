import { core } from "./core.js";

export function checkCore(): boolean {
  return core() === 1;
}
