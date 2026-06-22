// `prisma` is the Prisma client; access to `.user`/`.post` references the schema models.
// Declared inline so the fixture needs no @prisma/client install (detection is by name).
declare const prisma: {
  user: { findMany(): unknown[] };
  post: { create(): void };
};

export function listUsers() {
  return prisma.user.findMany();
}

export function createPost() {
  prisma.post.create();
}
