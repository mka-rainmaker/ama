export class Box {
  constructor(private readonly value: number) {}

  read(): number {
    return this.value;
  }

  double(): number {
    return this.value * 2;
  }
}
