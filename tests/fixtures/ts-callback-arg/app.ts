// Fixture for inline callbacks passed as call arguments (ama-y9q, ama-63x). A
// string-named wrapper call whose result is *consumed* turns the inline callback
// into its own Function node (named by the leading string literal), so the
// callback body's calls attribute to it rather than leaking to the enclosing
// function. Two shapes are covered:
//   - direct:        register("work",   wrap("work", () => …))
//   - doubly-wrapped: register("nested", wrap("nested", box(dep, () => …)))
// mirroring Ama's own tap("name", () => …) and tap("name", queryTool(session,
// () => …)). A fire-and-forget statement callback (the test-harness shape, e.g.
// each("…", () => …)) must stay transparent: no node, its body calls attribute
// to the enclosing scope.

export function helper(): number {
  return 1;
}

export function audited(): number {
  return 2;
}

export function loose(): number {
  return 3;
}

declare function register(name: string, handler: unknown): void;
declare function wrap<T>(name: string, fn: T): T;
declare function box<T>(dep: unknown, fn: T): T;
declare function each(name: string, fn: () => void): void;
declare const dep: unknown;

export function setup(): void {
  // Direct: `wrap("work", arrow)` is in value position (its result is passed to
  // register), so the arrow becomes "work handler" and its call to `helper`
  // attributes there.
  register(
    "work",
    wrap("work", () => {
      helper();
    }),
  );

  // Doubly-wrapped (ama-63x): the name lives on the value-position wrapper, but
  // the handler arrow is nested inside a second wrapper whose first arg is NOT a
  // string (mirrors tap("search", queryTool(session, () => …))). The handler is
  // still keyed by the outer name -> "nested handler".
  register(
    "nested",
    wrap(
      "nested",
      box(dep, () => {
        audited();
      }),
    ),
  );

  // `each(...)` is a bare expression statement (result discarded) — the
  // test-harness shape. Its callback must NOT become a node; the call to `loose`
  // stays attributed to `setup`.
  each("ignored", () => {
    loose();
  });
}
