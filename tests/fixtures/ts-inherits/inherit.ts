export class Animal {
  speak(): string {
    return "...";
  }
}

export class Dog extends Animal {
  speak(): string {
    return "woof";
  }
}

export interface Trainable {
  train(): void;
}

// `extends` and `implements` together: the base class is an Inherits edge,
// the interface an Implements edge — they must not be conflated.
export class ServiceDog extends Dog implements Trainable {
  train(): void {}
}

export class Standalone {}
