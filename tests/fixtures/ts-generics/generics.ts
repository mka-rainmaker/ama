// Fixture for generic instantiations: a type argument in a call or new
// expression should yield a UsesType edge, just like one inside an annotation.
export class Widget {}

export class Box<T> {
  item?: T;
}

export function generic<T>(arg?: T): void {
  void arg;
}

export function viaCall(): void {
  generic<Widget>();
}

export function viaNew(): void {
  new Box<Widget>();
}
