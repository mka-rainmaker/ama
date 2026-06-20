import type { Svc } from "./iface.js";
import { TOKEN } from "./iface.js";

export function use(s: Svc): void {
  s.run();
  console.log(TOKEN);
}
