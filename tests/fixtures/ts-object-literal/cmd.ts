// Fixture for object-literal methods: a const bound to an object literal whose
// function-valued members should each become a Method node (qualified by the
// const name), with calls in their bodies attributed to them. String-valued
// properties and the object const itself should NOT become nodes.
export function target(): number {
  return 1;
}

export const cmd = {
  name: "cmd",
  run(): number {
    return target();
  },
  handler: (): number => target(),
};
