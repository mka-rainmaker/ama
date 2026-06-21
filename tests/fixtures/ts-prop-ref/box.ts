export class Box {
  size = 0;

  constructor(private readonly value: number) {}

  read(): number {
    return this.value;
  }

  double(): number {
    return this.value * 2;
  }

  compare(other: Box): number {
    return other.value;
  }
}

export function widen(b: Box): number {
  return b.size;
}
