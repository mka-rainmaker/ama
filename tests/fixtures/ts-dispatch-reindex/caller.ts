import type { Svc } from "./iface.js";

export function use(s: Svc): void {
  s.run();
}
