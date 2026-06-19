// Fixture for RPC/schema-first handler awareness (ama-rme.11): tRPC procedures
// and a GraphQL resolver map link to their handler functions.
export function getUser(): string {
  return "u";
}
export function listUsers(): string[] {
  return [];
}

// tRPC: each router property is `procedure.query/mutation/subscription(handler)`.
declare const publicProcedure: {
  query(handler: unknown): unknown;
  mutation(handler: unknown): unknown;
};
declare function router(config: unknown): unknown;

export const appRouter = router({
  getUser: publicProcedure.query(getUser),
  createUser: publicProcedure.mutation(({ input }: { input: string }) => {
    void input;
  }),
});

// GraphQL: resolver map keyed by Query/Mutation, each field is a resolver fn.
export const resolvers = {
  Query: {
    users: listUsers,
  },
  Mutation: {
    deleteUser: () => {
      void 0;
    },
  },
};
