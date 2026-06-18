// Fixture for module-level variable/constant nodes (ama-hft.12). Plain-valued
// module-level declarations (numbers, arrays, Sets, `as const`) should each
// become a Variable node so "who references MAX_RETRIES" is answerable and the
// file outline is complete. Function-valued consts stay Function nodes; an
// object-literal const stays a non-node whose function members are Methods (the
// ama-zkr behaviour must be preserved).

export const MAX_RETRIES = 3;

const ROUTE_METHODS = new Set(["get", "post"]);

export const LABELS = ["a", "b"] as const;

export function useThem(): number {
  return MAX_RETRIES + (ROUTE_METHODS.has("get") ? 1 : 0) + LABELS.length;
}

// Object-literal const: `config` itself is NOT a node; `config.run` is a Method.
export const config = { name: "x", run: (): number => useThem() };

// Function-valued const: a Function node, not a Variable.
const handler = (): number => useThem();
void handler;
