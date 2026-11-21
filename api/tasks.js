// api/tasks.js — Vercel serverless function untuk POST /api/tasks.
import { handleRequest } from "../server.js";

export default async function handler(req, res) {
  req.url = "/api/tasks";
  await handleRequest(req, res);
}
