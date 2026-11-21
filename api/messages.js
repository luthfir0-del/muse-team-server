// api/messages.js — Vercel serverless function untuk POST /api/messages.
import { handleRequest } from "../server.js";

export default async function handler(req, res) {
  req.url = "/api/messages";
  await handleRequest(req, res);
}
