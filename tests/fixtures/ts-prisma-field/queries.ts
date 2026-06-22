import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function findUsers(email: string, name: string) {
  return prisma.user.findMany({
    where: { email, name },
    select: { id: true, email: true },
    orderBy: { createdAt: "desc" },
  });
}
