// api/state.js — Vercel serverless function untuk GET /api/state.
import { handleRequest } from "../server.js";

export default async function handler(req, res) {
  req.url = "/api/state";
  await handleRequest(req, res);
}
