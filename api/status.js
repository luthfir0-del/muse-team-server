// api/status.js — Vercel serverless function untuk POST /api/status.
import { handleRequest } from "../server.js";

export default async function handler(req, res) {
  req.url = "/api/status";
  await handleRequest(req, res);
}
