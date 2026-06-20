export function setup(): void {}
export function nested(): void {}

export function caller(): void {
  setup(); // inside a function — attributes to `caller`
}

function withCallback(fn: () => void): void {
  fn();
}

setup(); // module top-level — attributes to the File node (ama-53q)

withCallback(() => {
  nested(); // inside a callback (NOT file scope) — must NOT leak to the File
});
