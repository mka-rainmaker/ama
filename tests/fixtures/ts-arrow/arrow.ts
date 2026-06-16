// Fixture for function-valued const declarations: the arrow and the function
// expression should each become a Function node; the plain const should not.
export const greet = (): string => "hi";

// biome-ignore lint/complexity/useArrowFunction: intentionally a function expression to exercise that branch
export const compute = function (): number {
  return 1;
};

export const NOT_A_FN = 42;
