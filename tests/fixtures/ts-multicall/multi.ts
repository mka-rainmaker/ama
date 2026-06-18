// Fixture for per-call-site results (ama-hft.10): caller invokes target twice,
// so the single Calls edge should carry both call-site locations.
export function target(): void {}

export function caller(): void {
  target();
  target();
}
