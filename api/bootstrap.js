import { tursoBootstrap, isTursoConfigured } from "../lib/turso.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    if (!isTursoConfigured()) {
      return res.status(200).json({
        ok: false,
        message: "Turso no configurado",
        syncStatus: { estado: "offline", texto: "Sin conexión a base de datos" }
      });
    }

    const data = await tursoBootstrap();
    return res.status(200).json(data);
  } catch (err) {
    console.error("API /api/bootstrap error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
