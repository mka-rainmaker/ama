import express from "express";

const app = express();

export function listUsers(req: any, res: any): void {
  res.send("users");
}

// Named handler — should link via a References edge.
app.get("/users", listUsers);

// Inline handler — a Route node is still emitted (edge deferred to the
// arg-position-handler follow-up).
app.post("/users", (req: any, res: any) => {
  res.sendStatus(201);
});
