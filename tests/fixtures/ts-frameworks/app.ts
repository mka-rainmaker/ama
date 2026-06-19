// Fixture for object-config routes (ama-rme.10): Hapi and Fastify register routes
// via a config object (method + path/url + handler), unlike Express's x.get(path, h).
export function getUsers(): string[] {
  return [];
}

// Hapi: server.route({ method, path, handler })
declare const server: { route(config: unknown): void };
server.route({
  method: "GET",
  path: "/hapi/users",
  handler: getUsers,
});

// Fastify: fastify.route({ method, url, handler }) — note `url`, not `path`.
declare const fastify: {
  route(config: unknown): void;
  get(path: string, handler: unknown): void;
};
fastify.route({
  method: "POST",
  url: "/fastify/users",
  handler: getUsers,
});

// Fastify/Koa/Hono method-named routing — already covered by the Express path.
fastify.get("/fastify/health", getUsers);
