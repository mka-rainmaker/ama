// Fixture for EventEmitter on/emit call synthesis (ama-hft.14): publish() emits
// "data", which invokes the handler registered for "data" — a heuristic Calls edge.
import { EventEmitter } from "node:events";

export function handleData(payload: string): void {
  void payload;
}

export class Bus extends EventEmitter {
  setup(): void {
    this.on("data", handleData);
  }
  publish(): void {
    this.emit("data");
  }
}
