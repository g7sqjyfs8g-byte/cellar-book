export default async function handler(req, res) {
  const appsScriptUrl = process.env.GOOGLE_SHEETS_URL;
  const secret = process.env.GOOGLE_SHEETS_SECRET || "";

  if (!appsScriptUrl) {
    return res.status(500).json({ error: "GOOGLE_SHEETS_URL not configured" });
  }

  try {
    if (req.method === "GET") {
      const sheet = req.query.sheet || "";
      const url = `${appsScriptUrl}?secret=${encodeURIComponent(secret)}&sheet=${encodeURIComponent(sheet)}`;
      const upstream = await fetch(url, { redirect: "follow" });
      const text = await upstream.text();
      try { return res.status(200).json(JSON.parse(text)); }
      catch { return res.status(502).json({ error: "Invalid response from sheets backend" }); }
    }

    if (req.method === "POST") {
      const upstream = await fetch(appsScriptUrl, {
        method: "POST",
        redirect: "follow",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...req.body, secret }),
      });
      const text = await upstream.text();
      try { return res.status(200).json(JSON.parse(text)); }
      catch { return res.status(502).json({ error: "Invalid response from sheets backend" }); }
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("[api/sheets]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
