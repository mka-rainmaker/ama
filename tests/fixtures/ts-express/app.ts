import express from "express";

const app = express();

export function listUsers(req: any, res: any): void {
  res.send("users");
}

function audit(action: string): void {
  void action;
}

// Named handler — links to listUsers via a References edge.
app.get("/users", listUsers);

// Inline handler — becomes its own Function node; its body call to the local
// `audit` attributes to that handler node.
app.post("/users", (req: any, res: any) => {
  audit("create");
  res.sendStatus(201);
});
