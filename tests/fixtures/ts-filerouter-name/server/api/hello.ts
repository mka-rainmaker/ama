// Nuxt: server/api/hello.ts -> /api/hello, default export wrapped in defineEventHandler.
declare function defineEventHandler(h: unknown): unknown;
export default defineEventHandler((): string => "hi");
