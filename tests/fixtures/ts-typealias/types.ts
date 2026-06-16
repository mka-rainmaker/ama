// Fixture for type-alias nodes: the alias should become its own node, and a
// function that annotates a parameter with it should get a UsesType edge.
export type Status = "on" | "off";

export function label(s: Status): string {
  return String(s);
}
