import { Router } from "express";
import { db } from "../db";

export const users = Router();

users.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "");
  const rows = await db.query(
    `SELECT id, name, email FROM users WHERE name ILIKE '%${q}%' LIMIT 20`,
  );
  res.json(rows);
});
