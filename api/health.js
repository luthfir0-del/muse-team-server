// api/health.js — Vercel serverless function untuk GET /health.
import { handleRequest } from "../server.js";

export default async function handler(req, res) {
  req.url = "/health";
  await handleRequest(req, res);
}
