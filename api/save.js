import { tursoSavePayload, isTursoConfigured } from "../lib/turso.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    if (!isTursoConfigured()) {
      return res.status(500).json({ ok: false, message: "Base de datos Turso no configurada" });
    }

    const payload = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const result = await tursoSavePayload(payload);
    return res.status(200).json(result);
  } catch (err) {
    console.error("API /api/save error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
