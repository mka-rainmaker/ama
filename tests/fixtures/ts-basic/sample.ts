export function greet(name: string): string {
  return `hi ${name}`;
}

export class Greeter {
  greeting = "hi";

  greet(name: string): string {
    return this.greeting + name;
  }
}
