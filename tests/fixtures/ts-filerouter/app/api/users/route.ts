// Next.js App Router: app/api/users/route.ts -> /api/users, methods from exports.
export function GET(): string {
  return "[]";
}
export async function POST(): Promise<string> {
  return "ok";
}
