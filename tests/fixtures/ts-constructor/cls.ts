// Fixture for constructor nodes (ama-vz8). A class constructor often holds real
// wiring — calls and references — that was previously lost because the
// constructor wasn't emitted as a node. Here Widget's constructor calls `setup`
// and reads the module-level `LIMIT`, so each should attribute to
// `Widget.constructor`.
export const LIMIT = 10;

export function setup(): void {}

export class Widget {
  private cap: number;

  constructor() {
    setup();
    this.cap = LIMIT;
  }

  capacity(): number {
    return this.cap;
  }
}
