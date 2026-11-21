// api/mcp.js — Vercel serverless function untuk POST /mcp (MCP stateless).
// Tipis saja: merutekan ke handler yang sama dengan mode lokal (server.js).
import { handleRequest } from "../server.js";

export default async function handler(req, res) {
  req.url = "/mcp";
  await handleRequest(req, res);
}
