export interface Greeter {
  greet(): string;
}

export interface Named {
  name(): string;
}

export class FriendlyGreeter implements Greeter {
  greet(): string {
    return "hi";
  }
}

export class Person implements Greeter, Named {
  greet(): string {
    return "hello";
  }
  name(): string {
    return "person";
  }
}

export class Plain {}
