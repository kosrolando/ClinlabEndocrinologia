import { tursoSearch, isTursoConfigured } from "../lib/turso.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    if (!isTursoConfigured()) {
      return res.status(200).json([]);
    }

    const { q, code } = req.query || {};
    const results = await tursoSearch(q || "", code || "");
    return res.status(200).json(results);
  } catch (err) {
    console.error("API /api/search error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
