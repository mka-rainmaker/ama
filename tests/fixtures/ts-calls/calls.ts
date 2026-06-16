export function helper(): number {
  return 42;
}

export function main(): number {
  return helper();
}

export class Service {
  run(): number {
    return this.compute();
  }

  compute(): number {
    return helper();
  }
}
