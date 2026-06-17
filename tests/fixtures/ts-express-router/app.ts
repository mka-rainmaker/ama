import express from "express";

const app = express();
const router = express.Router();

export function listUsers(req: any, res: any): void {
  res.send("users");
}

// Defined on the router at "/users"…
router.get("/users", listUsers);

// …but the router is mounted at "/api", so the real route is GET /api/users.
app.use("/api", router);
