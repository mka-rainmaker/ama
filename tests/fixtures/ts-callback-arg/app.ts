// Fixture for inline callbacks passed as call arguments (ama-y9q). A string-named
// wrapper call whose result is *consumed* — register("work", wrap("work", () => …)) —
// should turn the inline callback into its own Function node (named by the leading
// string literal), so the callback body's calls attribute to it rather than leaking
// to the enclosing function. A fire-and-forget statement callback (the test-harness
// shape, e.g. each("…", () => …)) must stay transparent: no node, its body calls
// attribute to the enclosing scope.

export function helper(): number {
  return 1;
}

export function audited(): number {
  return 2;
}

declare function register(name: string, handler: unknown): void;
declare function wrap<T>(name: string, fn: T): T;
declare function each(name: string, fn: () => void): void;

export function setup(): void {
  // `wrap("work", arrow)` sits in value position (its result is passed to
  // register), so the arrow becomes the node "work handler" and its call to
  // `helper` attributes there.
  register(
    "work",
    wrap("work", () => {
      helper();
    }),
  );

  // `each(...)` is a bare expression statement (result discarded) — the
  // test-harness shape. Its callback must NOT become a node; the call to
  // `audited` stays attributed to `setup`.
  each("ignored", () => {
    audited();
  });
}
