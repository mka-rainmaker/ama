// Fixture for Module nodes (ama-hft.13): a namespace (members nest under it) and
// an ambient module declaration.
export namespace Geometry {
  export function area(): number {
    return 0;
  }
}

declare module "virtual:config" {
  export const setting: string;
}
