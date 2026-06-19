// Fixture for component nodes + hook usage (ama-rme.9): a React component (returns
// JSX), a Vue component (defineComponent), a custom hook, and a plain helper.
import { useState } from "react";
import { defineComponent } from "vue";

export function useCounter(): number {
  const [n] = useState(0);
  return n;
}

export function Button(): JSX.Element {
  const count = useCounter();
  return <button>{count}</button>;
}

export const Counter = defineComponent({
  setup() {
    return {};
  },
});

export function helper(): number {
  return 42;
}
