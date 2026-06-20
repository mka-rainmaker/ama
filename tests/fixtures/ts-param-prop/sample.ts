export interface Dep {
  run(): void;
}

export class Service {
  constructor(
    private readonly dep: Dep,
    public name: string,
    plain: number,
  ) {
    void plain;
  }

  go(): void {
    this.dep.run();
  }
}
