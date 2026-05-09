export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: "invalid url" }); }
  if (!parsed.hostname.endsWith("openfoodfacts.org")) {
    return res.status(403).json({ error: "domain not allowed" });
  }

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).json({ error: "upstream error" });
    const buffer = await upstream.arrayBuffer();
    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const base64 = Buffer.from(buffer).toString("base64");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.status(200).json({ dataUrl: `data:${contentType};base64,${base64}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
