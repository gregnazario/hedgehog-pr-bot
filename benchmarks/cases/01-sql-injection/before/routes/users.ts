import { Router } from "express";
import { db } from "../db";

export const users = Router();

users.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "");
  const rows = await db.query(
    `SELECT id, name, email FROM users WHERE name ILIKE '%' || $1 || '%' LIMIT 20`,
    [q],
  );
  res.json(rows);
});
