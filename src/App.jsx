import { useState, useEffect, useRef } from "react";

// ─── Anthropic API helper ─────────────────────────────────────────

// Extracts base64 data and the real media type from a data URL.
// Falls back to image/jpeg for unsupported types (HEIC etc).
const SUPPORTED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
function parseImageDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return { mediaType: "image/jpeg", data: dataUrl };
  const mediaType = SUPPORTED_TYPES.includes(match[1]) ? match[1] : "image/jpeg";
  return { mediaType, data: match[2] };
}

// Returns true for HEIC/HEIF files, which desktop browsers cannot decode.
function isHeic(file) {
  if (!file) return false;
  const name = file.name?.toLowerCase() ?? "";
  return file.type === "image/heic" || file.type === "image/heif" ||
    name.endsWith(".heic") || name.endsWith(".heif");
}

const HEIC_MSG = "HEIC images can't be processed on desktop browsers.\n\nPlease convert to JPEG first:\n• Mac: open in Preview → File → Export → select JPEG\n• iPhone: Settings → Camera → Formats → Most Compatible (shoots JPEG instead)";

// Resize to max 1200px and re-encode as PNG via canvas.
// Throws if the browser can't decode the image (e.g. HEIC on non-Safari).
function compressImage(dataUrl, maxPx = 1200) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas unavailable")); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const out = canvas.toDataURL("image/png");
      console.log(`[compressImage] ${img.width}x${img.height} → ${canvas.width}x${canvas.height}, ~${Math.round(out.length / 1024)}KB`);
      resolve(out);
    };
    img.onerror = () => reject(new Error("Browser could not decode this image format. If it's a HEIC file, please convert to JPEG first."));
    img.src = dataUrl;
  });
}

// Tiny thumbnail for Google Sheets storage (≤ 45,000 chars per cell limit).
// Returns null if compression still exceeds the limit.
function compressForSheet(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxPx = 160;
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const out = canvas.toDataURL("image/jpeg", 0.6);
      resolve(out.length <= 45000 ? out : null);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function searchWineImage(name, producer) {
  const query = [producer, name].filter(Boolean).join(" ");
  const res = await fetch(
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&action=process&json=true&page_size=5&search_simple=1`
  );
  const data = await res.json();
  for (const product of (data.products || [])) {
    const imageUrl = product.image_front_url || product.image_url;
    if (!imageUrl) continue;
    const proxyRes = await fetch(`/api/fetch-image?url=${encodeURIComponent(imageUrl)}`);
    if (!proxyRes.ok) continue;
    const { dataUrl } = await proxyRes.json();
    if (dataUrl) return dataUrl;
  }
  return null;
}

async function lookupHalliday(name, producer, vintage) {
  const wine = [producer, name, vintage].filter(Boolean).join(" ");
  const raw = await callClaude({
    maxTokens: 80,
    messages: [{ role: "user", content: `What is the James Halliday Wine Companion score (out of 100) for: ${wine}?\nReturn ONLY valid JSON: {"score":95} or {"score":null} if you are not confident. Do not guess.` }],
  });
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  return typeof parsed.score === "number" ? parsed.score : null;
}

async function lookupBarcode(barcode) {
  const res = await fetch(`https://world.openfoodfacts.org/product/${barcode}.json`);
  const data = await res.json();
  return data.status === 1 ? data.product : null;
}

async function parseWineFromProduct(product) {
  const info = [
    product.product_name && `Product: ${product.product_name}`,
    product.brands       && `Brand: ${product.brands}`,
    product.categories   && `Categories: ${product.categories}`,
    product.countries    && `Country: ${product.countries}`,
    product.quantity     && `Quantity: ${product.quantity}`,
  ].filter(Boolean).join("\n");

  const raw = await callClaude({
    maxTokens: 300,
    messages: [{ role: "user", content: `Extract wine details from this product listing:\n${info}\n\nReturn ONLY valid JSON (no markdown):\n{"name":"wine name without vintage","producer":"winery/producer","vintage":2024,"region":"region","country":"country","grape":"grape or blend","style":"Red|White|Rosé|Sparkling|Dessert|Orange"}\nUse null for unknown fields.` }],
  });
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

async function callClaude({ messages, system, maxTokens = 1024 }) {
  // Log image details before sending to help diagnose API errors
  messages.forEach((m, mi) => {
    if (!Array.isArray(m.content)) return;
    m.content.forEach((c, ci) => {
      if (c.type === "image") {
        console.log(`[callClaude] msg[${mi}].content[${ci}] image: media_type=${c.source?.media_type}, data length=${c.source?.data?.length ?? 0}`);
      }
    });
  });

  let res;
  try {
    res = await fetch("/api/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages,
      }),
    });
  } catch (networkErr) {
    console.error("[callClaude] Network error:", networkErr);
    throw new Error(`Network error: ${networkErr.message}`);
  }
  const responseText = await res.text();
  if (!res.ok) {
    let err = {};
    try { err = JSON.parse(responseText); } catch {}
    console.error("[callClaude] API error:", res.status, responseText.slice(0, 500));
    throw new Error(err?.error?.message || `API error ${res.status}`);
  }
  const data = JSON.parse(responseText);
  return data.content?.map(c => c.text || "").join("") || "";
}

const STYLES = ["Red", "White", "Rosé", "Sparkling", "Dessert", "Orange"];
const COUNTRIES = ["Australia", "France", "Italy", "Spain", "New Zealand", "USA", "Germany", "Portugal", "Argentina", "Chile", "Other"];
const REGIONS_AU = ["Barossa Valley", "McLaren Vale", "Clare Valley", "Eden Valley", "Coonawarra", "Margaret River", "Yarra Valley", "Hunter Valley", "Mornington Peninsula", "Tamar Valley", "Coal River", "Wrattonbully", "Other"];

const SEED_TASTINGS = [
  {
    id: "t1",
    name: "Petit Chablis",
    producer: "Christophe Patrice",
    vintage: 2024,
    region: "Chablis, Burgundy",
    country: "France",
    grape: "Chardonnay",
    style: "White",
    jmRating: 8.5,
    nickyRating: 8.5,
    notes: "Bone dry, high acid, flinty minerality. Perfect with seafood.",
    pairing: "Seafood at Que Sera",
    price: "",
    location: "Que Sera Food & Wine Bar",
    buyAgain: true,
    date: "2026-05-02",
    label: null,
  },
  {
    id: "t2",
    name: "Bremley Gamay",
    producer: "Bremley",
    vintage: 2024,
    region: "Coal River, TAS",
    country: "Australia",
    grape: "Gamay",
    style: "Red",
    jmRating: null,
    nickyRating: null,
    notes: "Tried at lunch — verdict pending.",
    pairing: "Seafood",
    price: "$72",
    location: "Restaurant",
    buyAgain: null,
    date: "2026-05-02",
    label: null,
  },
];

const SEED_CELLAR = [
  { id: "c1",  name: "Elderton Command Barossa Shiraz",                              producer: "Elderton",              vintage: 2017, region: "Barossa Valley", country: "Australia", grape: "Shiraz",                                          style: "Red", quantity: 1, drinkFrom: null, drinkBy: 2037, price: "$150", location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c2",  name: "Jacaranda Ridge Coonawarra Cabernet Sauvignon",                producer: "Orlando",               vintage: 2015, region: "Coonawarra",     country: "Australia", grape: "Cabernet Sauvignon",                              style: "Red", quantity: 1, drinkFrom: null, drinkBy: 2040, price: "$70",  location: "John's Cellar", notes: "Gift from Tim Micallef", dateAdded: "2026-01-01" },
  { id: "c3",  name: "Bin 150 Marananga Barossa Valley Shiraz",                      producer: "Penfolds",              vintage: 2019, region: "Barossa Valley", country: "Australia", grape: "Shiraz",                                          style: "Red", quantity: 1, drinkFrom: null, drinkBy: 2039, price: "$100", location: "John's Cellar", notes: "Gift",                  dateAdded: "2026-01-01" },
  { id: "c4",  name: "Bin 150 Marananga Shiraz",                                     producer: "Penfolds",              vintage: 2021, region: "Barossa Valley", country: "Australia", grape: "Shiraz",                                          style: "Red", quantity: 1, drinkFrom: null, drinkBy: 2045, price: "$100", location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c5",  name: "St Henri Shiraz",                                               producer: "Penfolds",              vintage: 2017, region: "McLaren Vale",   country: "Australia", grape: "Shiraz",                                          style: "Red", quantity: 1, drinkFrom: null, drinkBy: 2047, price: "$130", location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c6",  name: "St Henri Shiraz",                                               producer: "Penfolds",              vintage: 2020, region: "McLaren Vale",   country: "Australia", grape: "Shiraz",                                          style: "Red", quantity: 1, drinkFrom: null, drinkBy: 2045, price: "$136", location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c7",  name: "Single Vineyard Reserve Coquun Hunter Valley Shiraz",           producer: "Pepper Tree Wines",     vintage: 2017, region: "Hunter Valley",  country: "Australia", grape: "Shiraz",                                          style: "Red", quantity: 6, drinkFrom: null, drinkBy: 2036, price: "$90",  location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c8",  name: "Limited Release BDX-4",                                         producer: "Pepper Tree Wines",     vintage: 2022, region: "Wrattonbully",   country: "Australia", grape: "Cabernet Sauvignon Merlot Malbec Petit Verdot",   style: "Red", quantity: 1, drinkFrom: null, drinkBy: 2032, price: "$50",  location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c9",  name: "Limited Release Red Hill Hunter Valley Shiraz",                 producer: "Pepper Tree Wines",     vintage: 2019, region: "Hunter Valley",  country: "Australia", grape: "Shiraz",                                          style: "Red", quantity: 2, drinkFrom: null, drinkBy: 2028, price: "$50",  location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c10", name: "Premium Reserve Block 21A Cabernet Sauvignon",                  producer: "Pepper Tree Wines",     vintage: 2018, region: "Wrattonbully",   country: "Australia", grape: "Cabernet Sauvignon",                              style: "Red", quantity: 1, drinkFrom: null, drinkBy: 2032, price: "$60",  location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c11", name: "Single Vineyard Elderslee Road Reserve Cabernet Sauvignon",     producer: "Pepper Tree Wines",     vintage: 2018, region: "Wrattonbully",   country: "Australia", grape: "Cabernet Sauvignon",                              style: "Red", quantity: 1, drinkFrom: null, drinkBy: 2020, price: "$50",  location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c12", name: "Single Vineyard Premium Reserve The Gravels Shiraz",            producer: "Pepper Tree Wines",     vintage: 2019, region: "Wrattonbully",   country: "Australia", grape: "Shiraz",                                          style: "Red", quantity: 3, drinkFrom: null, drinkBy: 2029, price: "$50",  location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c13", name: "Single Vineyard Strandlines Reserve Cabernet Shiraz",           producer: "Pepper Tree Wines",     vintage: 2019, region: "Wrattonbully",   country: "Australia", grape: "Cabernet Shiraz",                                 style: "Red", quantity: 2, drinkFrom: null, drinkBy: 2033, price: "$60",  location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c14", name: "Stonewell Barossa Shiraz",                                      producer: "Peter Lehmann",         vintage: 2013, region: "Barossa Valley", country: "Australia", grape: "Shiraz",                                          style: "Red", quantity: 1, drinkFrom: null, drinkBy: 2045, price: "$75",  location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c15", name: "Ridge of Tears",                                                producer: "Logan Wines",           vintage: 2018, region: "",               country: "Australia", grape: "Shiraz",                                          style: "Red", quantity: 1, drinkFrom: null, drinkBy: 2026, price: "$45",  location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c16", name: "The Kinnear Mudgee Shiraz Cabernet",                            producer: "Robert Stein Vineyard", vintage: 2017, region: "Mudgee",         country: "Australia", grape: "Shiraz Cabernet",                                 style: "Red", quantity: 3, drinkFrom: null, drinkBy: 2027, price: "$90",  location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c17", name: "The Factor",                                                    producer: "Torbreck Vintners",     vintage: 2020, region: "Barossa Valley", country: "Australia", grape: "Shiraz",                                          style: "Red", quantity: 1, drinkFrom: null, drinkBy: 2043, price: "$150", location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c18", name: "The Struie",                                                    producer: "Torbreck Vintners",     vintage: 2021, region: "Barossa Valley", country: "Australia", grape: "Shiraz",                                          style: "Red", quantity: 1, drinkFrom: null, drinkBy: 2038, price: "$60",  location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c19", name: "Jack Roth Mudgee Shiraz",                                       producer: "Yeates Wines",          vintage: 2017, region: "Mudgee",         country: "Australia", grape: "Shiraz",                                          style: "Red", quantity: 3, drinkFrom: null, drinkBy: 2030, price: "$35",  location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
  { id: "c20", name: "Mudgee Cabernet Sauvignon",                                     producer: "Yeates Wines",          vintage: 2018, region: "Mudgee",         country: "Australia", grape: "Cabernet Sauvignon",                              style: "Red", quantity: 3, drinkFrom: null, drinkBy: 2025, price: "$65",  location: "John's Cellar", notes: "",                      dateAdded: "2026-01-01" },
];

// ─── Google Sheets API helpers ───────────────────────────────────────

async function sheetsGet(sheet) {
  const res = await fetch(`/api/sheets?sheet=${sheet}`, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function sheetsUpsert(sheet, row) {
  const res = await fetch("/api/sheets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "upsert", sheet, row }),
  });
  if (!res.ok) throw new Error(`Sheets ${res.status}`);
}

async function sheetsDelete(sheet, id) {
  const res = await fetch("/api/sheets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", sheet, id }),
  });
  if (!res.ok) throw new Error(`Sheets ${res.status}`);
}

async function sheetsReplace(sheet, rows) {
  const res = await fetch("/api/sheets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "replace", sheet, rows }),
  });
  if (!res.ok) throw new Error(`Sheets ${res.status}`);
}

// Pass all fields through; callers replace label with a compressed thumbnail before upserting
const toSheetTasting = (row) => row;

// Coerce types when reading back from sheets (cells may return numbers, booleans, or empty strings)
const fromSheetTasting = (row) => ({
  ...row,
  vintage: row.vintage ? Number(row.vintage) : null,
  jmRating: row.jmRating !== null && row.jmRating !== "" ? Number(row.jmRating) : null,
  nickyRating: row.nickyRating !== null && row.nickyRating !== "" ? Number(row.nickyRating) : null,
  buyAgain: row.buyAgain === true || row.buyAgain === "TRUE" || row.buyAgain === "true" ? true
    : row.buyAgain === false || row.buyAgain === "FALSE" || row.buyAgain === "false" ? false
    : null,
  label: row.label || null,
  hallidayRating: row.hallidayRating !== null && row.hallidayRating !== "" ? Number(row.hallidayRating) : null,
});

const fromSheetCellar = (row) => ({
  ...row,
  vintage: row.vintage ? Number(row.vintage) : null,
  quantity: row.quantity !== null && row.quantity !== "" ? Number(row.quantity) : 0,
  drinkFrom: row.drinkFrom ? Number(row.drinkFrom) : null,
  drinkBy: row.drinkBy ? Number(row.drinkBy) : null,
  label: row.label || null,
  hallidayRating: row.hallidayRating !== null && row.hallidayRating !== "" ? Number(row.hallidayRating) : null,
});

// ─── Tiny components ────────────────────────────────────────────────

const gold = "#c9a84c";
const blush = "#d4849a";

function Badge({ label, color = "#444", text = "#ccc" }) {
  return (
    <span style={{
      background: color, color: text,
      padding: "2px 9px", borderRadius: "20px",
      fontSize: "10px", fontWeight: 700,
      letterSpacing: "0.8px", textTransform: "uppercase",
      fontFamily: "monospace", whiteSpace: "nowrap",
    }}>{label}</span>
  );
}

const styleColors = {
  Red: ["#3a1010", "#c0392b"],
  White: ["#2a2800", "#c9a84c"],
  Rosé: ["#3a1020", "#d4849a"],
  Sparkling: ["#0a2030", "#6ab4d8"],
  Dessert: ["#2a1a00", "#e8a030"],
  Orange: ["#2a1800", "#d47820"],
};

function Input({ label, ...props }) {
  return (
    <div>
      {label && <div style={{ fontSize: "10px", color: "#666", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "5px", textTransform: "uppercase" }}>{label}</div>}
      <input {...props} style={{
        background: "#181818", border: "1px solid #2e2e2e",
        borderRadius: "8px", padding: "9px 12px",
        color: "#f0ebe0", fontSize: "13px", fontFamily: "monospace",
        width: "100%", boxSizing: "border-box", outline: "none",
        ...(props.style || {})
      }} />
    </div>
  );
}

function Select({ label, children, ...props }) {
  return (
    <div>
      {label && <div style={{ fontSize: "10px", color: "#666", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "5px", textTransform: "uppercase" }}>{label}</div>}
      <select {...props} style={{
        background: "#181818", border: "1px solid #2e2e2e",
        borderRadius: "8px", padding: "9px 12px",
        color: "#f0ebe0", fontSize: "13px", fontFamily: "monospace",
        width: "100%", boxSizing: "border-box", outline: "none",
      }}>{children}</select>
    </div>
  );
}

function Textarea({ label, ...props }) {
  return (
    <div>
      {label && <div style={{ fontSize: "10px", color: "#666", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "5px", textTransform: "uppercase" }}>{label}</div>}
      <textarea {...props} style={{
        background: "#181818", border: "1px solid #2e2e2e",
        borderRadius: "8px", padding: "9px 12px",
        color: "#f0ebe0", fontSize: "13px", fontFamily: "monospace",
        width: "100%", boxSizing: "border-box", outline: "none",
        resize: "vertical", minHeight: "72px",
        ...(props.style || {})
      }} />
    </div>
  );
}

function Btn({ children, variant = "ghost", onClick, disabled, style = {} }) {
  const base = {
    border: "none", borderRadius: "9px", cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "monospace", fontSize: "12px", padding: "9px 18px",
    transition: "opacity 0.15s", opacity: disabled ? 0.5 : 1, ...style,
  };
  const variants = {
    gold: { background: `linear-gradient(135deg, ${gold}, #a07830)`, color: "#fff", fontFamily: "'Playfair Display', serif", fontSize: "14px", fontWeight: 700 },
    ghost: { background: "#242424", color: "#aaa", border: "1px solid #333" },
    danger: { background: "#2a1010", color: "#c0392b", border: "1px solid #3a1515" },
    outline: { background: "transparent", color: gold, border: `1px solid ${gold}` },
  };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant] }}>{children}</button>;
}

// ─── Google Places Autocomplete ───────────────────────────────────

let _mapsPromise = null;
function loadGoogleMaps() {
  if (_mapsPromise) return _mapsPromise;
  _mapsPromise = new Promise((resolve, reject) => {
    if (window.google?.maps?.places) { resolve(); return; }
    const key = import.meta.env.VITE_GOOGLE_PLACES_KEY;
    if (!key) { reject(new Error("VITE_GOOGLE_PLACES_KEY not set")); return; }
    window.__gmCb = resolve;
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&callback=__gmCb`;
    s.async = true;
    s.onerror = () => reject(new Error("Failed to load Google Maps"));
    document.head.appendChild(s);
  });
  return _mapsPromise;
}

function PlacesAutocomplete({ label, value, onChange }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);
  const serviceRef = useRef(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    loadGoogleMaps()
      .then(() => { serviceRef.current = new window.google.maps.places.AutocompleteService(); })
      .catch(e => console.warn("[Places]", e.message));
  }, []);

  useEffect(() => {
    const close = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const handleChange = (e) => {
    const val = e.target.value;
    onChange(val);
    clearTimeout(debounceRef.current);
    if (!val.trim() || !serviceRef.current) { setSuggestions([]); setOpen(false); return; }
    debounceRef.current = setTimeout(() => {
      serviceRef.current.getPlacePredictions(
        { input: val, types: ["establishment"] },
        (preds, status) => {
          if (status === window.google.maps.places.PlacesServiceStatus.OK && preds?.length) {
            setSuggestions(preds.slice(0, 5));
            setOpen(true);
          } else {
            setSuggestions([]);
            setOpen(false);
          }
        }
      );
    }, 300);
  };

  const handleSelect = (pred) => {
    onChange(pred.structured_formatting?.main_text || pred.description);
    setSuggestions([]);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      {label && <div style={{ fontSize: "10px", color: "#666", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "5px", textTransform: "uppercase" }}>{label}</div>}
      <input
        value={value}
        onChange={handleChange}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        placeholder="Start typing a restaurant or venue…"
        style={{
          background: "#181818", border: "1px solid #2e2e2e", borderRadius: "8px",
          padding: "9px 12px", color: "#f0ebe0", fontSize: "13px", fontFamily: "monospace",
          width: "100%", boxSizing: "border-box", outline: "none",
        }}
      />
      {open && suggestions.length > 0 && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 2000,
          background: "#1c1c1c", border: "1px solid #2e2e2e", borderRadius: "8px",
          overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
        }}>
          {suggestions.map((pred, i) => (
            <div
              key={pred.place_id}
              onMouseDown={() => handleSelect(pred)}
              style={{
                padding: "10px 14px", cursor: "pointer",
                borderBottom: i < suggestions.length - 1 ? "1px solid #252525" : "none",
              }}
              onMouseEnter={e => e.currentTarget.style.background = "#272727"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <div style={{ fontSize: "13px", color: "#f0ebe0", fontFamily: "monospace" }}>
                {pred.structured_formatting?.main_text || pred.description}
              </div>
              {pred.structured_formatting?.secondary_text && (
                <div style={{ fontSize: "11px", color: "#555", fontFamily: "monospace", marginTop: "2px" }}>
                  {pred.structured_formatting.secondary_text}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Find Prices ──────────────────────────────────────────────────

function FindPrices({ wine }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const q = encodeURIComponent([wine.producer, wine.name, wine.vintage].filter(Boolean).join(" "));

  const stores = [
    { label: "Google Shopping", url: `https://www.google.com/search?q=${q}+wine&tbm=shop` },
    { label: "Vivino",          url: `https://www.vivino.com/search/wines?q=${q}` },
    { label: "Dan Murphy's",    url: `https://www.danmurphys.com.au/search?searchTerm=${q}` },
    { label: "BWS",             url: `https://www.bws.com.au/search?searchQuery=${q}` },
  ];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Btn onClick={() => setOpen(o => !o)} style={{ fontSize: "11px", padding: "5px 10px" }}>
        🔍 Find prices
      </Btn>
      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 500,
          background: "#1c1c1c", border: "1px solid #2e2e2e", borderRadius: "10px",
          overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.6)", minWidth: "160px",
        }}>
          {stores.map((s, i) => (
            <a
              key={s.label}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              style={{
                display: "block", padding: "10px 14px",
                fontSize: "12px", color: "#c9a84c", fontFamily: "monospace",
                textDecoration: "none",
                borderBottom: i < stores.length - 1 ? "1px solid #252525" : "none",
              }}
              onMouseEnter={e => e.currentTarget.style.background = "#272727"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              {s.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Barcode Scanner ──────────────────────────────────────────────

function BarcodeScanner({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const [status, setStatus] = useState("starting"); // starting | scanning | found | error
  const [errMsg, setErrMsg] = useState("");

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        if (!mounted) return;
        setStatus("scanning");
        const controls = await reader.decodeFromVideoDevice(
          undefined,
          videoRef.current,
          (result, _err, ctl) => {
            if (!mounted || !result) return;
            mounted = false;
            setStatus("found");
            ctl.stop();
            if (videoRef.current?.srcObject) {
              videoRef.current.srcObject.getTracks().forEach(t => t.stop());
            }
            setTimeout(() => onDetected(result.getText()), 350);
          }
        );
        controlsRef.current = controls;
      } catch (e) {
        if (mounted) { setStatus("error"); setErrMsg(e.message); }
      }
    })();
    return () => {
      mounted = false;
      try { controlsRef.current?.stop(); } catch {}
      if (videoRef.current?.srcObject) {
        videoRef.current.srcObject.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.97)",
      zIndex: 1100, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", padding: "20px",
    }}>
      <div style={{ width: "100%", maxWidth: "480px", display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "20px", color: "#f0ebe0" }}>Scan barcode</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#666", fontSize: "22px", cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>

        {status === "error" ? (
          <div style={{ background: "#1c1010", border: "1px solid #3a1010", borderRadius: "10px", padding: "20px", color: "#e05050", fontFamily: "monospace", fontSize: "12px", textAlign: "center" }}>
            Camera unavailable.<br /><span style={{ color: "#666" }}>{errMsg}</span>
          </div>
        ) : (
          <div style={{ position: "relative", borderRadius: "12px", overflow: "hidden", background: "#000", aspectRatio: "4/3" }}>
            <video ref={videoRef} muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            {/* Targeting guide */}
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
              <div style={{ width: "72%", height: "22%", border: `2px solid ${gold}`, borderRadius: "6px", opacity: status === "found" ? 1 : 0.75 }}>
                <div style={{ position: "absolute", top: 0, left: 0, width: "14px", height: "14px", borderTop: `2px solid ${gold}`, borderLeft: `2px solid ${gold}`, borderRadius: "2px 0 0 0" }} />
                <div style={{ position: "absolute", top: 0, right: 0, width: "14px", height: "14px", borderTop: `2px solid ${gold}`, borderRight: `2px solid ${gold}`, borderRadius: "0 2px 0 0" }} />
                <div style={{ position: "absolute", bottom: 0, left: 0, width: "14px", height: "14px", borderBottom: `2px solid ${gold}`, borderLeft: `2px solid ${gold}`, borderRadius: "0 0 0 2px" }} />
                <div style={{ position: "absolute", bottom: 0, right: 0, width: "14px", height: "14px", borderBottom: `2px solid ${gold}`, borderRight: `2px solid ${gold}`, borderRadius: "0 0 2px 0" }} />
              </div>
            </div>
          </div>
        )}

        <div style={{ textAlign: "center", fontFamily: "monospace", fontSize: "12px", color: status === "found" ? "#4caf79" : "#555" }}>
          {status === "starting" && "Starting camera…"}
          {status === "scanning" && "Point the barcode at the box above"}
          {status === "found"    && "✓ Barcode detected — looking up wine…"}
        </div>
      </div>
    </div>
  );
}

// ─── Tasting Detail Modal ─────────────────────────────────────────

function TastingDetail({ wine, onEdit, onDelete, onClose, onFindLabel, onFindHalliday }) {
  const both = wine.jmRating != null && wine.nickyRating != null;
  const avg = both ? ((wine.jmRating + wine.nickyRating) / 2).toFixed(1) : null;
  const [sc, tc] = styleColors[wine.style] || ["#222", "#888"];
  const [finding, setFinding] = useState(false);
  const [findMsg, setFindMsg] = useState("");
  const [findingH, setFindingH] = useState(false);
  const [hallidayMsg, setHallidayMsg] = useState("");

  const handleFindLabel = async () => {
    setFinding(true);
    setFindMsg("");
    const found = await onFindLabel(wine);
    setFinding(false);
    setFindMsg(found ? "✓ Label image saved." : "No image found — try uploading one manually.");
  };

  const handleFindHalliday = async () => {
    setFindingH(true);
    setHallidayMsg("");
    const score = await onFindHalliday(wine);
    setFindingH(false);
    setHallidayMsg(score != null ? `✓ Found: ${score}/100` : "Not found in Claude's knowledge — add manually.");
  };

  return (
    <Modal title="" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
        {/* Header */}
        <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
          {wine.label ? (
            <img src={wine.label} alt="label" style={{ width: "64px", height: "88px", objectFit: "cover", borderRadius: "8px", border: "1px solid #333", flexShrink: 0 }} />
          ) : onFindLabel && (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "center", flexShrink: 0 }}>
              <div style={{ width: "64px", height: "88px", background: "#131313", border: "1px dashed #333", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "22px" }}>🍷</div>
              <Btn onClick={handleFindLabel} disabled={finding} style={{ fontSize: "10px", padding: "4px 8px", whiteSpace: "nowrap" }}>
                {finding ? "Searching…" : "Find image"}
              </Btn>
              {findMsg && <div style={{ fontSize: "10px", fontFamily: "monospace", color: findMsg.startsWith("✓") ? "#4caf79" : "#666", textAlign: "center", maxWidth: "64px" }}>{findMsg}</div>}
            </div>
          )}
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px", flexWrap: "wrap" }}>
              <Badge label={wine.style} color={sc} text={tc} />
              {wine.buyAgain && <Badge label="✓ Buy Again" color="#0e2a1a" text="#4caf79" />}
            </div>
            <div style={{ color: "#666", fontSize: "11px", fontFamily: "monospace", marginBottom: "2px" }}>
              {wine.vintage || "NV"} · {wine.country}
            </div>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "22px", fontWeight: 700, color: "#f0ebe0", lineHeight: 1.2, marginBottom: "2px" }}>
              {wine.name}
            </div>
            <div style={{ color: "#999", fontSize: "13px" }}>{wine.producer}</div>
            {(wine.grape || wine.region) && (
              <div style={{ color: "#555", fontSize: "11px", fontFamily: "monospace", marginTop: "2px" }}>
                {wine.grape}{wine.region ? ` · ${wine.region}` : ""}
              </div>
            )}
          </div>
        </div>

        {/* Ratings */}
        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", alignItems: "flex-end" }}>
          {[["JM", wine.jmRating, gold], ["NICKY", wine.nickyRating, blush], both && ["AVG", avg, "#f0ebe0"]].filter(Boolean).map(([lbl, val, col]) => (
            <div key={lbl} style={{ textAlign: "center" }}>
              <div style={{ fontSize: "9px", color: "#555", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "2px" }}>{lbl}</div>
              <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "32px", fontWeight: 700, color: col }}>{val ?? "—"}</div>
            </div>
          ))}
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "9px", color: "#555", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "2px" }}>HALLIDAY</div>
            {wine.hallidayRating != null ? (
              <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "32px", fontWeight: 700, color: "#e8562a" }}>{wine.hallidayRating}</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", alignItems: "center" }}>
                <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "32px", fontWeight: 700, color: "#333" }}>—</div>
                {onFindHalliday && (
                  <Btn onClick={handleFindHalliday} disabled={findingH} style={{ fontSize: "10px", padding: "3px 8px" }}>
                    {findingH ? "Looking…" : "Look up"}
                  </Btn>
                )}
                {hallidayMsg && <div style={{ fontSize: "10px", fontFamily: "monospace", color: hallidayMsg.startsWith("✓") ? "#e8562a" : "#555", maxWidth: "80px", textAlign: "center" }}>{hallidayMsg}</div>}
              </div>
            )}
          </div>
        </div>

        {/* Notes */}
        {wine.notes && (
          <div style={{ background: "#131313", borderLeft: `2px solid ${gold}`, padding: "10px 14px", borderRadius: "4px", fontSize: "13px", color: "#bbb", fontStyle: "italic", lineHeight: 1.6 }}>
            {wine.notes}
          </div>
        )}

        {/* Details grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
          {[
            ["Pairing",  wine.pairing],
            ["Price",    wine.price],
            ["Where",    wine.location],
            ["Date",     wine.date],
          ].filter(([, v]) => v).map(([label, value]) => (
            <div key={label} style={{ background: "#131313", borderRadius: "8px", padding: "10px 12px" }}>
              <div style={{ fontSize: "9px", color: "#555", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "3px", textTransform: "uppercase" }}>{label}</div>
              <div style={{ fontSize: "13px", color: "#ccc" }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center", paddingTop: "4px" }}>
          <FindPrices wine={wine} />
          <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
            <Btn variant="danger" onClick={() => { onDelete(wine.id); onClose(); }}>Delete</Btn>
            <Btn variant="gold" onClick={() => { onEdit(wine); onClose(); }}>Edit</Btn>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─── Tasting Card ─────────────────────────────────────────────────

function TastingCard({ wine, onView }) {
  const both = wine.jmRating != null && wine.nickyRating != null;
  const avg = both ? ((wine.jmRating + wine.nickyRating) / 2).toFixed(1) : (wine.jmRating ?? wine.nickyRating ?? null);
  const [sc, tc] = styleColors[wine.style] || ["#222", "#888"];
  return (
    <div
      onClick={onView}
      style={{
        background: "linear-gradient(160deg, #1c1c1c 0%, #202020 100%)",
        border: "1px solid #2a2a2a", borderRadius: "16px",
        padding: "22px", position: "relative", overflow: "hidden",
        transition: "transform 0.18s, box-shadow 0.18s", cursor: "pointer",
      }}
      onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 10px 36px rgba(0,0,0,0.45)"; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = ""; }}
    >
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "3px", background: tc, opacity: 0.7 }} />
      <div style={{ position: "absolute", top: "16px", right: "16px", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "8px" }}>
        <Badge label={wine.style} color={sc} text={tc} />
        {wine.label && (
          <img src={wine.label} alt="label" style={{ height: "72px", width: "52px", objectFit: "cover", borderRadius: "6px", border: "1px solid #333", background: "#111" }} />
        )}
      </div>

      <div style={{ color: "#666", fontSize: "12px", fontFamily: "monospace", marginBottom: "3px" }}>
        {wine.vintage || "NV"} · {wine.country}
      </div>
      <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "20px", fontWeight: 700, color: "#f0ebe0", lineHeight: 1.2, marginBottom: "2px", paddingRight: "70px" }}>
        {wine.name}
      </div>
      <div style={{ color: "#999", fontSize: "13px", marginBottom: "3px" }}>{wine.producer}</div>
      <div style={{ color: "#555", fontSize: "11px", fontFamily: "monospace", marginBottom: "16px" }}>
        {wine.grape}{wine.region ? ` · ${wine.region}` : ""}
      </div>

      <div style={{ display: "flex", gap: "20px", marginBottom: "14px", flexWrap: "wrap" }}>
        {[["JM", wine.jmRating, gold], ["NICKY", wine.nickyRating, blush], both && ["AVG", avg, "#f0ebe0"]].filter(Boolean).map(([lbl, val, col]) => (
          <div key={lbl}>
            <div style={{ fontSize: "9px", color: "#555", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "2px" }}>{lbl}</div>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "26px", fontWeight: 700, color: col }}>{val ?? "—"}</div>
          </div>
        ))}
        {wine.hallidayRating != null && (
          <div>
            <div style={{ fontSize: "9px", color: "#555", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "2px" }}>HALLIDAY</div>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "26px", fontWeight: 700, color: "#e8562a" }}>{wine.hallidayRating}</div>
          </div>
        )}
      </div>

      {wine.notes && (
        <div style={{ background: "#131313", borderLeft: `2px solid ${gold}`, padding: "9px 12px", borderRadius: "4px", fontSize: "12px", color: "#bbb", fontStyle: "italic", marginBottom: "12px", lineHeight: 1.5 }}>
          {wine.notes}
        </div>
      )}

      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        {wine.buyAgain && <Badge label="✓ Buy Again" color="#0e2a1a" text="#4caf79" />}
        {wine.hallidayRating != null && <Badge label={`H·${wine.hallidayRating}`} color="#2a0a06" text="#e8562a" />}
      </div>
    </div>
  );
}

// ─── Cellar Detail Modal ──────────────────────────────────────────

function CellarDetail({ wine, onEdit, onDelete, onQty, onClose, onFindHalliday }) {
  const [sc, tc] = styleColors[wine.style] || ["#222", "#888"];
  const currentYear = new Date().getFullYear();
  const readyNow = wine.drinkFrom ? currentYear >= wine.drinkFrom : true;
  const overdue = wine.drinkBy ? currentYear > wine.drinkBy : false;
  const [findingH, setFindingH] = useState(false);
  const [hallidayMsg, setHallidayMsg] = useState("");

  const handleFindHalliday = async () => {
    setFindingH(true);
    setHallidayMsg("");
    const score = await onFindHalliday(wine);
    setFindingH(false);
    setHallidayMsg(score != null ? `✓ Found: ${score}/100` : "Not found — add manually.");
  };

  return (
    <Modal title="" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
        {/* Header */}
        <div style={{ display: "flex", gap: "16px", alignItems: "flex-start" }}>
          {wine.label && (
            <img src={wine.label} alt="label" style={{ width: "64px", height: "88px", objectFit: "cover", borderRadius: "8px", border: "1px solid #333", flexShrink: 0 }} />
          )}
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px", flexWrap: "wrap" }}>
              <Badge label={wine.style} color={sc} text={tc} />
              {overdue && <Badge label="Drink now!" color="#3a1010" text="#e05050" />}
              {!overdue && readyNow && wine.drinkBy && <Badge label="Ready" color="#0e2a1a" text="#4caf79" />}
              {!readyNow && <Badge label={`From ${wine.drinkFrom}`} color="#1a1a2a" text="#6a8ad8" />}
            </div>
            <div style={{ color: "#666", fontSize: "11px", fontFamily: "monospace", marginBottom: "2px" }}>
              {wine.vintage || "NV"} · {wine.country}
            </div>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "22px", fontWeight: 700, color: "#f0ebe0", lineHeight: 1.2, marginBottom: "2px" }}>
              {wine.name}
            </div>
            <div style={{ color: "#999", fontSize: "13px" }}>{wine.producer}</div>
            {(wine.grape || wine.region) && (
              <div style={{ color: "#555", fontSize: "11px", fontFamily: "monospace", marginTop: "2px" }}>
                {wine.grape}{wine.region ? ` · ${wine.region}` : ""}
              </div>
            )}
          </div>
        </div>

        {/* Quantity adjuster */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px", background: "#131313", borderRadius: "10px", padding: "12px 16px" }}>
          <div style={{ fontSize: "10px", color: "#555", fontFamily: "monospace", letterSpacing: "1px", textTransform: "uppercase", flex: 1 }}>Bottles in cellar</div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <Btn onClick={() => onQty(wine.id, -1)} style={{ padding: "5px 14px", fontSize: "18px" }}>−</Btn>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "28px", fontWeight: 700, color: gold, minWidth: "32px", textAlign: "center" }}>{wine.quantity}</div>
            <Btn onClick={() => onQty(wine.id, 1)} style={{ padding: "5px 14px", fontSize: "18px" }}>+</Btn>
          </div>
        </div>

        {/* Halliday rating */}
        <div style={{ background: "#131313", borderRadius: "10px", padding: "12px 16px", display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "9px", color: "#555", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "4px", textTransform: "uppercase" }}>James Halliday</div>
            {wine.hallidayRating != null ? (
              <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "28px", fontWeight: 700, color: "#e8562a" }}>{wine.hallidayRating}<span style={{ fontSize: "13px", color: "#555", marginLeft: "4px" }}>/100</span></div>
            ) : (
              <div style={{ fontSize: "13px", color: "#444", fontFamily: "monospace" }}>Not rated</div>
            )}
            {hallidayMsg && <div style={{ fontSize: "11px", fontFamily: "monospace", color: hallidayMsg.startsWith("✓") ? "#e8562a" : "#555", marginTop: "4px" }}>{hallidayMsg}</div>}
          </div>
          {onFindHalliday && (
            <Btn onClick={handleFindHalliday} disabled={findingH} style={{ fontSize: "11px", padding: "6px 12px" }}>
              {findingH ? "Looking…" : wine.hallidayRating != null ? "Refresh" : "Look up"}
            </Btn>
          )}
        </div>

        {/* Details grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
          {[
            ["Drink from",  wine.drinkFrom],
            ["Drink by",    wine.drinkBy],
            ["Price paid",  wine.price],
            ["Location",    wine.location],
            ["Added",       wine.dateAdded],
          ].filter(([, v]) => v).map(([label, value]) => (
            <div key={label} style={{ background: "#131313", borderRadius: "8px", padding: "10px 12px" }}>
              <div style={{ fontSize: "9px", color: "#555", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "3px", textTransform: "uppercase" }}>{label}</div>
              <div style={{ fontSize: "13px", color: "#ccc" }}>{value}</div>
            </div>
          ))}
        </div>

        {wine.notes && (
          <div style={{ background: "#131313", borderLeft: `2px solid ${gold}`, padding: "10px 14px", borderRadius: "4px", fontSize: "13px", color: "#bbb", fontStyle: "italic", lineHeight: 1.6 }}>
            {wine.notes}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center", paddingTop: "4px" }}>
          <FindPrices wine={wine} />
          <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
            <Btn variant="danger" onClick={() => { onDelete(wine.id); onClose(); }}>Delete</Btn>
            <Btn variant="gold" onClick={() => { onEdit(wine); onClose(); }}>Edit</Btn>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─── Cellar Row ────────────────────────────────────────────────────

function CellarRow({ wine, onView, onQty }) {
  const [sc, tc] = styleColors[wine.style] || ["#222", "#888"];
  const currentYear = new Date().getFullYear();
  const readyNow = wine.drinkFrom ? currentYear >= wine.drinkFrom : true;
  const overdue = wine.drinkBy ? currentYear > wine.drinkBy : false;
  return (
    <div
      onClick={onView}
      style={{
        background: "#1a1a1a", border: "1px solid #272727",
        borderRadius: "12px", padding: "14px 18px", cursor: "pointer",
        display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap",
        transition: "background 0.15s",
      }}
      onMouseEnter={e => e.currentTarget.style.background = "#1e1e1e"}
      onMouseLeave={e => e.currentTarget.style.background = "#1a1a1a"}
    >
      <div style={{ width: "6px", height: "40px", borderRadius: "3px", background: tc, flexShrink: 0 }} />
      {wine.label && (
        <img src={wine.label} alt="label" style={{ height: "44px", width: "32px", objectFit: "cover", borderRadius: "4px", border: "1px solid #2e2e2e", flexShrink: 0 }} />
      )}
      <div style={{ flex: 1, minWidth: "160px" }}>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "16px", color: "#f0ebe0", lineHeight: 1.2 }}>{wine.name}</div>
        <div style={{ fontSize: "11px", color: "#666", fontFamily: "monospace" }}>
          {wine.producer}{wine.vintage ? ` · ${wine.vintage}` : ""}{wine.region ? ` · ${wine.region}` : ""}
        </div>
      </div>

      <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
        {overdue && <Badge label="Drink now!" color="#3a1010" text="#e05050" />}
        {!overdue && readyNow && wine.drinkBy && <Badge label="Ready" color="#0e2a1a" text="#4caf79" />}
        {!readyNow && <Badge label={`From ${wine.drinkFrom}`} color="#1a1a2a" text="#6a8ad8" />}
        {wine.hallidayRating != null && <Badge label={`H·${wine.hallidayRating}`} color="#2a0a06" text="#e8562a" />}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "8px" }} onClick={e => e.stopPropagation()}>
        <Btn onClick={() => onQty(wine.id, -1)} style={{ padding: "5px 12px", fontSize: "16px" }}>−</Btn>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "22px", fontWeight: 700, color: gold, minWidth: "28px", textAlign: "center" }}>{wine.quantity}</div>
        <Btn onClick={() => onQty(wine.id, 1)} style={{ padding: "5px 12px", fontSize: "16px" }}>+</Btn>
      </div>
    </div>
  );
}

// ─── Tasting Form ─────────────────────────────────────────────────

function TastingForm({ wine, onSave, onCancel }) {
  const blank = {
    name: "", producer: "", vintage: "", region: "", country: "France",
    grape: "", style: "White", jmRating: "", nickyRating: "", hallidayRating: "",
    notes: "", pairing: "", price: "", location: "",
    buyAgain: false, date: new Date().toISOString().split("T")[0], label: null,
  };
  const [form, setForm] = useState(wine ? { ...wine, vintage: wine.vintage ?? "", jmRating: wine.jmRating ?? "", nickyRating: wine.nickyRating ?? "", hallidayRating: wine.hallidayRating ?? "" } : blank);
  const [aiLoading, setAiLoading] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [barcodeMsg, setBarcodeMsg] = useState("");
  const [hallidayLoading, setHallidayLoading] = useState(false);
  const fileRef = useRef();
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleImage = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (isHeic(file)) { alert(HEIC_MSG); e.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = async () => { try { set("label", await compressImage(reader.result)); } catch (err) { alert(err.message); } };
    reader.readAsDataURL(file);
  };

  const handleAI = async () => {
    if (!form.label) return;
    setAiLoading(true);
    try {
      const { mediaType, data: imgData } = parseImageDataUrl(form.label);
      const raw = await callClaude({
        maxTokens: 500,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imgData } },
          { type: "text", text: `Read this wine label. Return ONLY valid JSON, no markdown:\n{"name":"wine name only","producer":"winery/producer","vintage":2024,"region":"region","country":"country","grape":"grape or blend","style":"Red|White|Rosé|Sparkling|Dessert|Orange"}\nUse null for unknown fields.` }
        ]}],
      });
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      setForm(f => ({
        ...f,
        ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => v != null)),
        vintage: parsed.vintage ?? f.vintage,
      }));
    } catch (e) {
      console.error("[TastingForm] Label read error:", e.message);
      alert(`Couldn't read the label: ${e.message}`);
    }
    setAiLoading(false);
  };

  const handleBarcode = async (code) => {
    setShowScanner(false);
    setBarcodeMsg("Looking up wine…");
    try {
      const product = await lookupBarcode(code);
      if (!product) {
        setBarcodeMsg(`Barcode ${code} not found in database. Fill in details manually.`);
        return;
      }
      const parsed = await parseWineFromProduct(product);
      setForm(f => ({
        ...f,
        ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => v != null)),
        vintage: parsed.vintage ? String(parsed.vintage) : f.vintage,
      }));
      setBarcodeMsg("✓ Wine details filled from barcode.");
    } catch (e) {
      setBarcodeMsg(`Lookup failed: ${e.message}`);
    }
  };

  const handleSave = () => {
    if (!form.name.trim()) return alert("Wine name is required.");
    onSave({
      ...form,
      id: form.id || `t${Date.now()}`,
      vintage: form.vintage ? parseInt(form.vintage) : null,
      jmRating: form.jmRating !== "" ? parseFloat(form.jmRating) : null,
      nickyRating: form.nickyRating !== "" ? parseFloat(form.nickyRating) : null,
      hallidayRating: form.hallidayRating !== "" ? parseInt(form.hallidayRating) : null,
    });
  };

  return (
    <Modal title={wine ? "Edit tasting" : "Log a tasting"} onClose={onCancel}>
      {showScanner && <BarcodeScanner onDetected={handleBarcode} onClose={() => setShowScanner(false)} />}
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        {/* Label photo + barcode */}
        <div>
          <div style={{ fontSize: "10px", color: "#666", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "6px", textTransform: "uppercase" }}>Label photo</div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <Btn onClick={() => fileRef.current.click()} style={{ background: "#242424", border: "1px dashed #444", color: "#aaa" }}>📷 Upload</Btn>
            <Btn onClick={() => { setBarcodeMsg(""); setShowScanner(true); }} style={{ background: "#242424", border: "1px dashed #444", color: "#aaa" }}>🔍 Scan barcode</Btn>
            {form.label && (
              <Btn variant="outline" onClick={handleAI} disabled={aiLoading}>
                {aiLoading ? "Reading…" : "✨ Auto-fill from label"}
              </Btn>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" onChange={handleImage} style={{ display: "none" }} />
          {barcodeMsg && <div style={{ marginTop: "8px", fontSize: "11px", fontFamily: "monospace", color: barcodeMsg.startsWith("✓") ? "#4caf79" : "#888" }}>{barcodeMsg}</div>}
          {form.label && <img src={form.label} alt="" style={{ marginTop: "10px", height: "100px", borderRadius: "8px", objectFit: "contain", border: "1px solid #333" }} />}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <div style={{ gridColumn: "1/-1" }}><Input label="Wine Name *" value={form.name} onChange={e => set("name", e.target.value)} placeholder="e.g. Petit Chablis" /></div>
          <Input label="Producer / Winery" value={form.producer} onChange={e => set("producer", e.target.value)} />
          <Input label="Vintage" type="number" value={form.vintage} onChange={e => set("vintage", e.target.value)} placeholder="2024" />
          <Input label="Region" value={form.region} onChange={e => set("region", e.target.value)} />
          <Select label="Country" value={form.country} onChange={e => set("country", e.target.value)}>
            {COUNTRIES.map(c => <option key={c}>{c}</option>)}
          </Select>
          <Input label="Grape / Blend" value={form.grape} onChange={e => set("grape", e.target.value)} />
          <Select label="Style" value={form.style} onChange={e => set("style", e.target.value)}>
            {STYLES.map(s => <option key={s}>{s}</option>)}
          </Select>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <Input label="JM Rating /10" type="number" min="0" max="10" step="0.5" value={form.jmRating} onChange={e => set("jmRating", e.target.value)} placeholder="0–10" />
          <Input label="Nicky Rating /10" type="number" min="0" max="10" step="0.5" value={form.nickyRating} onChange={e => set("nickyRating", e.target.value)} placeholder="0–10" />
          <div style={{ display: "flex", gap: "6px", alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}><Input label="Halliday /100" type="number" min="0" max="100" step="1" value={form.hallidayRating} onChange={e => set("hallidayRating", e.target.value)} placeholder="e.g. 95" /></div>
            <Btn onClick={async () => { setHallidayLoading(true); const s = await lookupHalliday(form.name, form.producer, form.vintage); if (s != null) set("hallidayRating", String(s)); setHallidayLoading(false); }} disabled={hallidayLoading || !form.name} style={{ marginBottom: "0", padding: "9px 10px", fontSize: "11px", whiteSpace: "nowrap" }}>
              {hallidayLoading ? "…" : "Look up"}
            </Btn>
          </div>
        </div>

        <Textarea label="Tasting Notes" value={form.notes} onChange={e => set("notes", e.target.value)} placeholder="What did you taste? What stood out?" />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <Input label="Food Pairing" value={form.pairing} onChange={e => set("pairing", e.target.value)} />
          <Input label="Price" value={form.price} onChange={e => set("price", e.target.value)} placeholder="e.g. $66" />
          <PlacesAutocomplete label="Where" value={form.location} onChange={val => set("location", val)} />
          <Input label="Date" type="date" value={form.date} onChange={e => set("date", e.target.value)} />
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
          <input type="checkbox" checked={form.buyAgain} onChange={e => set("buyAgain", e.target.checked)} style={{ width: "16px", height: "16px", accentColor: gold }} />
          <span style={{ color: "#aaa", fontSize: "13px", fontFamily: "monospace" }}>Would buy again</span>
        </label>

        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", paddingTop: "6px" }}>
          <Btn onClick={onCancel}>Cancel</Btn>
          <Btn variant="gold" onClick={handleSave}>Save</Btn>
        </div>
      </div>
    </Modal>
  );
}

// ─── Cellar Form ──────────────────────────────────────────────────

function CellarForm({ wine, onSave, onCancel }) {
  const blank = {
    name: "", producer: "", vintage: "", region: "", country: "Australia",
    grape: "", style: "Red", quantity: 1, drinkFrom: "", drinkBy: "",
    price: "", location: "John's Cellar", notes: "", hallidayRating: "",
    dateAdded: new Date().toISOString().split("T")[0], label: null,
  };
  const [form, setForm] = useState(wine ? {
    ...wine,
    vintage: wine.vintage ?? "",
    drinkFrom: wine.drinkFrom ?? "",
    drinkBy: wine.drinkBy ?? "",
    hallidayRating: wine.hallidayRating ?? "",
  } : blank);
  const [aiLoading, setAiLoading] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [barcodeMsg, setBarcodeMsg] = useState("");
  const [hallidayLoading, setHallidayLoading] = useState(false);
  const fileRef = useRef();
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleImage = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (isHeic(file)) { alert(HEIC_MSG); e.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = async () => { try { set("label", await compressImage(reader.result)); } catch (err) { alert(err.message); } };
    reader.readAsDataURL(file);
  };

  const handleAI = async () => {
    if (!form.label) return;
    setAiLoading(true);
    try {
      const { mediaType, data: imgData } = parseImageDataUrl(form.label);
      const raw = await callClaude({
        maxTokens: 500,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imgData } },
          { type: "text", text: `Read this wine label. Return ONLY valid JSON, no markdown:\n{"name":"wine name only","producer":"winery/producer","vintage":2024,"region":"region","country":"country","grape":"grape or blend","style":"Red|White|Rosé|Sparkling|Dessert|Orange"}\nUse null for unknown fields.` }
        ]}],
      });
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      setForm(f => ({
        ...f,
        ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => v != null)),
        vintage: parsed.vintage ?? f.vintage,
      }));
    } catch (e) {
      console.error("[CellarForm] Label read error:", e.message);
      alert(`Couldn't read the label: ${e.message}`);
    }
    setAiLoading(false);
  };

  const handleBarcode = async (code) => {
    setShowScanner(false);
    setBarcodeMsg("Looking up wine…");
    try {
      const product = await lookupBarcode(code);
      if (!product) {
        setBarcodeMsg(`Barcode ${code} not found in database. Fill in details manually.`);
        return;
      }
      const parsed = await parseWineFromProduct(product);
      setForm(f => ({
        ...f,
        ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => v != null)),
        vintage: parsed.vintage ? String(parsed.vintage) : f.vintage,
      }));
      setBarcodeMsg("✓ Wine details filled from barcode.");
    } catch (e) {
      setBarcodeMsg(`Lookup failed: ${e.message}`);
    }
  };

  const handleSave = () => {
    if (!form.name.trim()) return alert("Wine name is required.");
    onSave({
      ...form,
      id: form.id || `c${Date.now()}`,
      vintage: form.vintage ? parseInt(form.vintage) : null,
      drinkFrom: form.drinkFrom ? parseInt(form.drinkFrom) : null,
      drinkBy: form.drinkBy ? parseInt(form.drinkBy) : null,
      quantity: parseInt(form.quantity) || 1,
      hallidayRating: form.hallidayRating !== "" ? parseInt(form.hallidayRating) : null,
    });
  };

  return (
    <Modal title={wine ? "Edit cellar entry" : "Add to cellar"} onClose={onCancel}>
      {showScanner && <BarcodeScanner onDetected={handleBarcode} onClose={() => setShowScanner(false)} />}
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <div>
          <div style={{ fontSize: "10px", color: "#666", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "6px", textTransform: "uppercase" }}>Label photo (optional)</div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <Btn onClick={() => fileRef.current.click()} style={{ background: "#242424", border: "1px dashed #444", color: "#aaa" }}>📷 Upload</Btn>
            <Btn onClick={() => { setBarcodeMsg(""); setShowScanner(true); }} style={{ background: "#242424", border: "1px dashed #444", color: "#aaa" }}>🔍 Scan barcode</Btn>
            {form.label && <Btn variant="outline" onClick={handleAI} disabled={aiLoading}>{aiLoading ? "Reading…" : "✨ Auto-fill from label"}</Btn>}
          </div>
          <input ref={fileRef} type="file" accept="image/*" onChange={handleImage} style={{ display: "none" }} />
          {barcodeMsg && <div style={{ marginTop: "8px", fontSize: "11px", fontFamily: "monospace", color: barcodeMsg.startsWith("✓") ? "#4caf79" : "#888" }}>{barcodeMsg}</div>}
          {form.label && <img src={form.label} alt="" style={{ marginTop: "10px", height: "90px", borderRadius: "8px", objectFit: "contain", border: "1px solid #333" }} />}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          <div style={{ gridColumn: "1/-1" }}><Input label="Wine Name *" value={form.name} onChange={e => set("name", e.target.value)} /></div>
          <Input label="Producer" value={form.producer} onChange={e => set("producer", e.target.value)} />
          <Input label="Vintage" type="number" value={form.vintage} onChange={e => set("vintage", e.target.value)} placeholder="e.g. 2019" />
          <Input label="Region" value={form.region} onChange={e => set("region", e.target.value)} />
          <Select label="Country" value={form.country} onChange={e => set("country", e.target.value)}>
            {COUNTRIES.map(c => <option key={c}>{c}</option>)}
          </Select>
          <Input label="Grape / Blend" value={form.grape} onChange={e => set("grape", e.target.value)} />
          <Select label="Style" value={form.style} onChange={e => set("style", e.target.value)}>
            {STYLES.map(s => <option key={s}>{s}</option>)}
          </Select>
          <Input label="Quantity (bottles)" type="number" min="1" value={form.quantity} onChange={e => set("quantity", e.target.value)} />
          <Input label="Drink From (year)" type="number" value={form.drinkFrom} onChange={e => set("drinkFrom", e.target.value)} placeholder="e.g. 2026" />
          <Input label="Drink By (year)" type="number" value={form.drinkBy} onChange={e => set("drinkBy", e.target.value)} placeholder="e.g. 2032" />
          <Input label="Price Paid" value={form.price} onChange={e => set("price", e.target.value)} placeholder="e.g. $120" />
          <Input label="Storage Location" value={form.location} onChange={e => set("location", e.target.value)} />
          <div style={{ display: "flex", gap: "6px", alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}><Input label="Halliday /100" type="number" min="0" max="100" step="1" value={form.hallidayRating} onChange={e => set("hallidayRating", e.target.value)} placeholder="e.g. 95" /></div>
            <Btn onClick={async () => { setHallidayLoading(true); const s = await lookupHalliday(form.name, form.producer, form.vintage); if (s != null) set("hallidayRating", String(s)); setHallidayLoading(false); }} disabled={hallidayLoading || !form.name} style={{ padding: "9px 10px", fontSize: "11px", whiteSpace: "nowrap" }}>
              {hallidayLoading ? "…" : "Look up"}
            </Btn>
          </div>
        </div>

        <Textarea label="Notes" value={form.notes} onChange={e => set("notes", e.target.value)} />

        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", paddingTop: "6px" }}>
          <Btn onClick={onCancel}>Cancel</Btn>
          <Btn variant="gold" onClick={handleSave}>Save</Btn>
        </div>
      </div>
    </Modal>
  );
}

// ─── Modal ────────────────────────────────────────────────────────

function Modal({ title, children, onClose }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)",
      zIndex: 1000, overflowY: "auto", padding: "24px 16px",
      display: "flex", justifyContent: "center", alignItems: "flex-start",
    }}>
      <div style={{
        background: "#181818", border: "1px solid #2a2a2a",
        borderRadius: "20px", padding: "28px 26px",
        width: "100%", maxWidth: "580px", position: "relative",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "22px" }}>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "22px", color: "#f0ebe0" }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#666", fontSize: "20px", cursor: "pointer" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Tab nav ──────────────────────────────────────────────────────

function TabBar({ active, onChange }) {
  return (
    <div style={{ display: "flex", borderBottom: "1px solid #1e1e1e", padding: "0 20px" }}>
      {[["tastings", "🍷 Tastings"], ["cellar", "🏠 Cellar"], ["stats", "📊 Stats"], ["sommelier", "🧑‍🍳 Sommelier"]].map(([key, label]) => (
        <button key={key} onClick={() => onChange(key)} style={{
          background: "none", border: "none", cursor: "pointer",
          padding: "14px 20px", fontSize: "13px", fontFamily: "monospace",
          color: active === key ? gold : "#666",
          borderBottom: active === key ? `2px solid ${gold}` : "2px solid transparent",
          marginBottom: "-1px", transition: "color 0.15s",
        }}>{label}</button>
      ))}
    </div>
  );
}

// ─── Stats ────────────────────────────────────────────────────────

function Stats({ tastings, cellar, bulkH, onPopulateHalliday, onResetBulk }) {
  const rated = tastings.filter(w => w.jmRating != null || w.nickyRating != null);
  const avgJM = rated.filter(w => w.jmRating).length
    ? (rated.filter(w => w.jmRating).reduce((s, w) => s + w.jmRating, 0) / rated.filter(w => w.jmRating).length).toFixed(1)
    : "—";
  const avgNicky = rated.filter(w => w.nickyRating).length
    ? (rated.filter(w => w.nickyRating).reduce((s, w) => s + w.nickyRating, 0) / rated.filter(w => w.nickyRating).length).toFixed(1)
    : "—";
  const totalBottles = cellar.reduce((s, w) => s + (w.quantity || 0), 0);
  const byStyle = STYLES.map(s => ({ s, count: tastings.filter(w => w.style === s).length })).filter(x => x.count > 0).sort((a, b) => b.count - a.count);
  const byCountry = [...new Set(tastings.map(w => w.country))].map(c => ({ c, count: tastings.filter(w => w.country === c).length })).sort((a, b) => b.count - a.count).slice(0, 6);
  const top = [...tastings].filter(w => w.jmRating && w.nickyRating).sort((a, b) => ((b.jmRating + b.nickyRating) / 2) - ((a.jmRating + a.nickyRating) / 2)).slice(0, 3);

  const StatCard = ({ label, value, color }) => (
    <div style={{ background: "#1a1a1a", border: "1px solid #272727", borderRadius: "12px", padding: "16px 20px", textAlign: "center" }}>
      <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "32px", fontWeight: 700, color: color || "#f0ebe0" }}>{value}</div>
      <div style={{ fontSize: "10px", color: "#555", fontFamily: "monospace", letterSpacing: "1px", marginTop: "4px", textTransform: "uppercase" }}>{label}</div>
    </div>
  );

  return (
    <div style={{ padding: "24px", maxWidth: "900px", margin: "0 auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "12px", marginBottom: "28px" }}>
        <StatCard label="Wines Tasted" value={tastings.length} />
        <StatCard label="JM Avg" value={avgJM} color={gold} />
        <StatCard label="Nicky Avg" value={avgNicky} color={blush} />
        <StatCard label="Buy Again" value={tastings.filter(w => w.buyAgain).length} color="#4caf79" />
        <StatCard label="In Cellar" value={totalBottles} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", marginBottom: "28px" }}>
        <div style={{ background: "#1a1a1a", border: "1px solid #272727", borderRadius: "12px", padding: "18px 20px" }}>
          <div style={{ fontSize: "11px", color: "#666", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "14px", textTransform: "uppercase" }}>By Style</div>
          {byStyle.map(({ s, count }) => {
            const [, tc] = styleColors[s] || ["#222", "#888"];
            const pct = Math.round((count / tastings.length) * 100);
            return (
              <div key={s} style={{ marginBottom: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "#aaa", fontFamily: "monospace", marginBottom: "4px" }}>
                  <span>{s}</span><span>{count}</span>
                </div>
                <div style={{ background: "#111", borderRadius: "4px", height: "6px" }}>
                  <div style={{ background: tc, height: "6px", borderRadius: "4px", width: `${pct}%`, transition: "width 0.5s" }} />
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ background: "#1a1a1a", border: "1px solid #272727", borderRadius: "12px", padding: "18px 20px" }}>
          <div style={{ fontSize: "11px", color: "#666", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "14px", textTransform: "uppercase" }}>By Country</div>
          {byCountry.map(({ c, count }) => {
            const pct = Math.round((count / tastings.length) * 100);
            return (
              <div key={c} style={{ marginBottom: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "#aaa", fontFamily: "monospace", marginBottom: "4px" }}>
                  <span>{c}</span><span>{count}</span>
                </div>
                <div style={{ background: "#111", borderRadius: "4px", height: "6px" }}>
                  <div style={{ background: gold, height: "6px", borderRadius: "4px", width: `${pct}%`, opacity: 0.7, transition: "width 0.5s" }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {top.length > 0 && (
        <div style={{ background: "#1a1a1a", border: "1px solid #272727", borderRadius: "12px", padding: "18px 20px" }}>
          <div style={{ fontSize: "11px", color: "#666", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "14px", textTransform: "uppercase" }}>Top Rated (Both)</div>
          {top.map((w, i) => (
            <div key={w.id} style={{ display: "flex", alignItems: "center", gap: "14px", padding: "10px 0", borderBottom: i < top.length - 1 ? "1px solid #222" : "none" }}>
              <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "22px", color: gold, width: "28px" }}>{i + 1}</div>
              <div style={{ flex: 1 }}>
                <div style={{ color: "#f0ebe0", fontSize: "14px" }}>{w.name}</div>
                <div style={{ color: "#666", fontSize: "11px", fontFamily: "monospace" }}>{w.producer} · {w.vintage || "NV"}</div>
              </div>
              <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "22px", fontWeight: 700, color: "#f0ebe0" }}>
                {((w.jmRating + w.nickyRating) / 2).toFixed(1)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Halliday bulk populate */}
      <div style={{ background: "#1a1a1a", border: "1px solid #272727", borderRadius: "12px", padding: "20px" }}>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "18px", color: "#f0ebe0", marginBottom: "4px" }}>James Halliday Scores</div>
        <div style={{ fontSize: "11px", color: "#555", fontFamily: "monospace", marginBottom: "14px" }}>
          {[...tastings, ...cellar].filter(w => w.hallidayRating != null).length} of {tastings.length + cellar.length} wines rated
        </div>

        {!bulkH ? (
          <Btn variant="outline" onClick={onPopulateHalliday}>
            Populate all missing scores
          </Btn>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ flex: 1, height: "6px", background: "#2a2a2a", borderRadius: "3px", overflow: "hidden" }}>
                <div style={{ height: "100%", background: "#e8562a", borderRadius: "3px", width: `${bulkH.total ? (bulkH.done / bulkH.total) * 100 : 100}%`, transition: "width 0.3s" }} />
              </div>
              <div style={{ fontSize: "11px", fontFamily: "monospace", color: "#666", whiteSpace: "nowrap" }}>
                {bulkH.done}/{bulkH.total}
              </div>
            </div>
            <div style={{ maxHeight: "220px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "3px" }}>
              {bulkH.log.map((line, i) => (
                <div key={i} style={{ fontSize: "11px", fontFamily: "monospace", color: line.startsWith("✓") ? "#e8562a" : "#444" }}>{line}</div>
              ))}
            </div>
            {bulkH.done === bulkH.total && (
              <Btn onClick={onResetBulk} style={{ alignSelf: "flex-start" }}>Done</Btn>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sommelier ────────────────────────────────────────────────────

function Sommelier({ tastings }) {
  const [mode, setMode] = useState("ask");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [dish, setDish] = useState("");
  const [restaurant, setRestaurant] = useState("");
  const [wineListImg, setWineListImg] = useState(null);
  const [loading, setLoading] = useState(false);
  const [bottleImg, setBottleImg] = useState(null);
  const chatRef = useRef();
  const fileRef = useRef();
  const bottleFileRef = useRef();

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, loading]);

  const preferenceProfile = () => {
    if (!tastings.length) return "";
    const rated = tastings.filter(w => w.jmRating || w.nickyRating);
    const top = [...rated]
      .sort((a, b) => {
        const avg = w => ((w.jmRating || 0) + (w.nickyRating || 0)) / ((w.jmRating ? 1 : 0) + (w.nickyRating ? 1 : 0) || 1);
        return avg(b) - avg(a);
      })
      .slice(0, 6)
      .map(w => `${w.name} by ${w.producer} (${w.grape}, rated ${w.jmRating ?? w.nickyRating}/10)`);
    const buyAgain = tastings.filter(w => w.buyAgain).map(w => `${w.name} (${w.grape})`).slice(0, 5);
    const styleCounts = {};
    tastings.forEach(w => { if (w.style) styleCounts[w.style] = (styleCounts[w.style] || 0) + 1; });
    const favStyles = Object.entries(styleCounts).sort((a, b) => b[1] - a[1]).map(([s]) => s);
    const regions = [...new Set(tastings.map(w => w.region).filter(Boolean))].slice(0, 6);
    return [
      top.length ? `Favourite wines: ${top.join("; ")}` : "",
      buyAgain.length ? `Would buy again: ${buyAgain.join(", ")}` : "",
      favStyles.length ? `Preferred styles: ${favStyles.join(", ")}` : "",
      regions.length ? `Familiar regions: ${regions.join(", ")}` : "",
    ].filter(Boolean).join("\n");
  };

  const system = (m) => {
    const prefs = preferenceProfile();
    const base = `You are an expert sommelier with deep knowledge of wine regions, grapes, vintages, and food pairing. You're advising JM and Nicky, a couple who love wine.${prefs ? `\n\nTheir wine profile:\n${prefs}` : ""}\n\nBe specific, concise, and conversational. Use bullet points or numbered lists where helpful. Highlight producer names and wine names in bold.`;
    if (m === "meal") return base + "\n\nFor meal pairing: recommend 2–3 specific wines (producer, grape, region, approx price), explain why each works with the dish, and note which best suits their preferences.";
    if (m === "restaurant") return base + "\n\nFor restaurant pairing: read the wine list carefully, recommend 2–3 wines from it for the specified dish, quote wine names exactly as they appear on the list, explain each pairing, and name your top pick clearly.";
    return base;
  };

  const claudeChat = (msgs, sys) => callClaude({ messages: msgs, system: sys });

  const push = (role, text, extras = {}) =>
    setMessages(prev => [...prev, { role, text, ...extras }]);

  const handleAsk = async () => {
    if (!input.trim() || loading) return;
    const text = input.trim();
    setInput("");
    push("user", text, { mode: "ask" });
    setLoading(true);
    try {
      const history = [...messages.filter(m => m.mode === "ask"), { role: "user", text, mode: "ask" }]
        .map(m => ({ role: m.role, content: m.text }));
      const reply = await claudeChat(history, system("ask"));
      push("assistant", reply, { mode: "ask" });
    } catch (e) {
      push("assistant", "Sorry, I couldn't reach the sommelier. Please try again.", { mode: "ask", isError: true });
    }
    setLoading(false);
  };

  const handleMealPairing = async () => {
    if (!dish.trim() || loading) return;
    const text = `I'm planning to cook: ${dish.trim()}. What wines would you recommend?`;
    push("user", `🍽 ${dish.trim()}`, { mode: "meal" });
    setDish("");
    setLoading(true);
    try {
      const reply = await claudeChat([{ role: "user", content: text }], system("meal"));
      push("assistant", reply, { mode: "meal" });
    } catch (e) {
      push("assistant", "Sorry, I couldn't reach the sommelier. Please try again.", { mode: "meal", isError: true });
    }
    setLoading(false);
  };

  const handleRestaurantPairing = async () => {
    if (loading || (!dish.trim() && !wineListImg)) return;
    const summary = [restaurant && `📍 ${restaurant}`, dish && `🍽 ${dish}`, wineListImg && "📷 Wine list attached"].filter(Boolean).join("  ·  ");
    push("user", summary, { mode: "restaurant", hasImage: !!wineListImg });
    setLoading(true);
    try {
      const content = [];
      if (wineListImg) {
        const { mediaType, data: imgData } = parseImageDataUrl(wineListImg);
        content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: imgData } });
      }
      const parts = [];
      if (restaurant) parts.push(`Restaurant: ${restaurant}`);
      if (dish) parts.push(`My dish: ${dish}`);
      parts.push(wineListImg ? "Read the wine list in the image and recommend the best pairings for my dish." : "Suggest wines that would pair well with my dish.");
      content.push({ type: "text", text: parts.join("\n") });
      const reply = await claudeChat([{ role: "user", content }], system("restaurant"));
      push("assistant", reply, { mode: "restaurant" });
    } catch (e) {
      push("assistant", "Sorry, I couldn't reach the sommelier. Please try again.", { mode: "restaurant", isError: true });
    }
    setLoading(false);
  };

  const handleBottleAnalysis = async () => {
    if (!bottleImg || loading) return;
    push("user", "📷 Bottle photo submitted", { mode: "bottle", hasBottleImg: true, bottleImg });
    setLoading(true);
    try {
      const { mediaType, data: imgData } = parseImageDataUrl(bottleImg);
      const prefs = preferenceProfile();
      const sys = `You are an expert sommelier. Analyse the wine in the photo and return a structured response with exactly these three sections, using ## headings:\n\n## Tasting Notes\nDescribe the likely flavour profile, aroma, and palate — colour, nose, palate, finish. Be specific to this wine's grape variety, region, and vintage if visible.\n\n## Food Pairings\nRecommend 4–6 specific dishes that pair well with this wine. For each, briefly explain why it works. Use bullet points.\n\n## Serving Suggestions\nCover ideal serving temperature, whether to decant and for how long, and best glass style.\n\nBe specific and confident. Bold the wine name and producer where you reference them.${prefs ? `\n\nFor context, JM and Nicky's wine preferences:\n${prefs}` : ""}`;
      const reply = await callClaude({
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imgData } },
          { type: "text", text: "Please analyse this wine and provide tasting notes, food pairing recommendations, and serving suggestions." },
        ]}],
        system: sys,
        maxTokens: 1200,
      });
      push("assistant", reply, { mode: "bottle" });
    } catch (e) {
      push("assistant", "Sorry, I couldn't analyse that bottle. Please try again.", { mode: "bottle", isError: true });
    }
    setLoading(false);
    setBottleImg(null);
  };

  const renderText = (text) =>
    text.split("\n").map((line, i) => {
      const isBullet = /^[-•*]\s/.test(line);
      const isNumbered = /^\d+\.\s/.test(line);
      const isHeader = /^#{1,3}\s/.test(line);
      const stripped = line.replace(/^#{1,3}\s/, "").replace(/^[-•*\d.]\s*/, "");
      const parts = stripped.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
        p.startsWith("**") && p.endsWith("**")
          ? <strong key={j} style={{ color: gold }}>{p.slice(2, -2)}</strong>
          : p
      );
      return (
        <div key={i} style={{
          marginBottom: isHeader ? "8px" : (isBullet || isNumbered) ? "5px" : "2px",
          paddingLeft: (isBullet || isNumbered) ? "16px" : 0,
          fontSize: isHeader ? "14px" : "13px",
          color: isHeader ? "#f0ebe0" : "#c0b8a8",
          fontWeight: isHeader ? 700 : 400,
          fontFamily: isHeader ? "'Playfair Display', serif" : "monospace",
          lineHeight: 1.65, position: "relative",
        }}>
          {(isBullet || isNumbered) && (
            <span style={{ position: "absolute", left: 0, color: gold }}>
              {isBullet ? "·" : (line.match(/^\d+/) || [""])[0] + "."}
            </span>
          )}
          {parts}
        </div>
      );
    });

  const modeInfo = {
    ask:        { label: "💬 Ask Anything",    placeholder: "Ask about regions, grapes, vintages, serving temps…",   empty: ["Ask me anything about wine", "Regions, grapes, vintages, serving temperatures…"] },
    meal:       { label: "🍽 Meal Pairing",    placeholder: "",                                                        empty: ["Tell me what you're cooking", "I'll suggest wines matched to your preferences"] },
    restaurant: { label: "🍾 Restaurant List", placeholder: "",                                                        empty: ["Share the wine list and your dish", "Upload a photo of the wine list for the best results"] },
    bottle:     { label: "📷 Analyse Label",   placeholder: "",                                                        empty: ["Photograph a bottle or label", "I'll identify the wine and give you tasting notes, food pairings, and serving tips"] },
  };

  return (
    <div style={{ maxWidth: "900px", margin: "0 auto", padding: "20px" }}>
      {/* Header */}
      <div style={{ marginBottom: "22px" }}>
        <div style={{ fontSize: "10px", letterSpacing: "4px", color: gold, fontFamily: "monospace", marginBottom: "6px" }}>POWERED BY YOUR TASTING HISTORY</div>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "28px", fontWeight: 700, color: "#f0ebe0" }}>Virtual Sommelier</div>
        <div style={{ fontSize: "11px", color: "#444", fontFamily: "monospace", marginTop: "3px" }}>{tastings.length} wines on record · preferences personalised</div>
      </div>

      {/* Mode selector */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "20px", flexWrap: "wrap", alignItems: "center" }}>
        {Object.entries(modeInfo).map(([m, { label }]) => (
          <button key={m} onClick={() => setMode(m)} style={{
            background: mode === m ? gold : "#1a1a1a",
            border: `1px solid ${mode === m ? gold : "#2e2e2e"}`,
            borderRadius: "20px", padding: "8px 18px",
            color: mode === m ? "#111" : "#888",
            cursor: "pointer", fontSize: "12px", fontFamily: "monospace",
            fontWeight: mode === m ? 700 : 400, transition: "all 0.15s",
          }}>{label}</button>
        ))}
        {messages.length > 0 && (
          <button onClick={() => setMessages([])} style={{
            marginLeft: "auto", background: "transparent", border: "1px solid #252525",
            borderRadius: "20px", padding: "8px 14px", color: "#444",
            cursor: "pointer", fontSize: "11px", fontFamily: "monospace",
          }}>Clear chat</button>
        )}
      </div>

      {/* Chat display */}
      <div ref={chatRef} style={{
        display: "flex", flexDirection: "column", gap: "14px",
        minHeight: "140px", maxHeight: "500px", overflowY: "auto",
        marginBottom: "16px",
      }}>
        {messages.length === 0 && !loading && (
          <div style={{ textAlign: "center", padding: "52px 20px" }}>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "18px", color: "#2a2a2a", marginBottom: "8px" }}>
              {modeInfo[mode].empty[0]}
            </div>
            <div style={{ fontSize: "11px", color: "#2e2e2e", fontFamily: "monospace" }}>
              {modeInfo[mode].empty[1]}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start", gap: "10px", alignItems: "flex-start" }}>
            {msg.role === "assistant" && (
              <div style={{
                width: "32px", height: "32px", borderRadius: "50%", flexShrink: 0,
                background: `linear-gradient(135deg, ${gold}, #a07830)`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "15px", marginTop: "2px",
              }}>🍷</div>
            )}
            <div style={{
              maxWidth: "78%",
              background: msg.role === "user"
                ? "linear-gradient(135deg, rgba(201,168,76,0.1), rgba(201,168,76,0.05))"
                : "#1a1a1a",
              border: `1px solid ${msg.role === "user" ? "rgba(201,168,76,0.2)" : "#272727"}`,
              borderRadius: msg.role === "user" ? "16px 16px 4px 16px" : "4px 16px 16px 16px",
              padding: "12px 16px",
            }}>
              {msg.role === "assistant"
                ? renderText(msg.text)
                : <div style={{ fontSize: "13px", color: "#e0d8c8", fontFamily: "monospace", lineHeight: 1.5 }}>
                    {msg.hasImage && <span style={{ fontSize: "11px", color: "#666", display: "block", marginBottom: "4px" }}>📷 Wine list attached</span>}
                    {msg.hasBottleImg && <img src={msg.bottleImg} alt="Bottle" style={{ display: "block", maxHeight: "140px", maxWidth: "100%", borderRadius: "8px", objectFit: "contain", marginBottom: "6px" }} />}
                    {msg.text}
                  </div>
              }
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
            <div style={{
              width: "32px", height: "32px", borderRadius: "50%",
              background: `linear-gradient(135deg, ${gold}, #a07830)`,
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: "15px",
            }}>🍷</div>
            <div style={{ background: "#1a1a1a", border: "1px solid #272727", borderRadius: "4px 16px 16px 16px", padding: "14px 18px" }}>
              <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
                {[0, 1, 2].map(j => (
                  <div key={j} style={{
                    width: "6px", height: "6px", borderRadius: "50%", background: gold,
                    animation: `somm-pulse 1.2s ease-in-out ${j * 0.2}s infinite`,
                  }} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Ask mode ── */}
      {mode === "ask" && (
        <div style={{ display: "flex", gap: "10px" }}>
          <input
            value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAsk(); } }}
            placeholder={modeInfo.ask.placeholder}
            disabled={loading}
            style={{
              flex: 1, background: "#161616", border: "1px solid #2a2a2a",
              borderRadius: "12px", padding: "12px 16px", color: "#f0ebe0",
              fontSize: "13px", fontFamily: "monospace", outline: "none",
            }}
          />
          <Btn variant="gold" onClick={handleAsk} disabled={loading || !input.trim()} style={{ padding: "12px 26px" }}>Ask</Btn>
        </div>
      )}

      {/* ── Meal Pairing mode ── */}
      {mode === "meal" && (
        <div style={{ background: "#161616", border: "1px solid #222", borderRadius: "16px", padding: "18px" }}>
          <Textarea
            label="What are you cooking?"
            value={dish} onChange={e => setDish(e.target.value)}
            placeholder="e.g. Slow-braised lamb shoulder with rosemary and garlic, roasted root vegetables"
            style={{ minHeight: "64px" }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "12px" }}>
            <Btn variant="gold" onClick={handleMealPairing} disabled={loading || !dish.trim()}>Get Recommendations</Btn>
          </div>
        </div>
      )}

      {/* ── Restaurant mode ── */}
      {mode === "restaurant" && (
        <div style={{ background: "#161616", border: "1px solid #222", borderRadius: "16px", padding: "18px", display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <Input label="Restaurant Name" value={restaurant} onChange={e => setRestaurant(e.target.value)} placeholder="e.g. Quay, Sydney" />
            <Input label="Your Dish" value={dish} onChange={e => setDish(e.target.value)} placeholder="e.g. Pan-seared barramundi" />
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#666", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "8px", textTransform: "uppercase" }}>Wine List Photo</div>
            <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
              <Btn onClick={() => fileRef.current.click()} style={{ background: "#242424", border: "1px dashed #444", color: "#aaa" }}>📷 Upload Wine List</Btn>
              {wineListImg && <>
                <span style={{ fontSize: "11px", color: "#4caf79", fontFamily: "monospace" }}>✓ Photo ready</span>
                <button onClick={() => setWineListImg(null)} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: "11px", fontFamily: "monospace" }}>Remove</button>
              </>}
            </div>
            <input ref={fileRef} type="file" accept="image/*"              onChange={e => { const f = e.target.files[0]; if (!f) return; if (isHeic(f)) { alert(HEIC_MSG); e.target.value = ""; return; } const r = new FileReader(); r.onload = async () => { try { setWineListImg(await compressImage(r.result)); } catch (err) { alert(err.message); } }; r.readAsDataURL(f); }}
              style={{ display: "none" }} />
            {wineListImg && <img src={wineListImg} alt="Wine list" style={{ marginTop: "10px", maxHeight: "160px", borderRadius: "8px", objectFit: "contain", border: "1px solid #2a2a2a" }} />}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="gold" onClick={handleRestaurantPairing} disabled={loading || (!dish.trim() && !wineListImg)}>Get Pairing</Btn>
          </div>
        </div>
      )}

      {/* ── Bottle Analysis mode ── */}
      {mode === "bottle" && (
        <div style={{ background: "#161616", border: "1px solid #222", borderRadius: "16px", padding: "18px", display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ fontSize: "12px", color: "#888", fontFamily: "monospace", lineHeight: 1.6 }}>
            Take a photo of a wine bottle or label — I'll identify the wine and return tasting notes, food pairings, and serving suggestions.
          </div>
          <div>
            <div style={{ fontSize: "10px", color: "#666", fontFamily: "monospace", letterSpacing: "1px", marginBottom: "8px", textTransform: "uppercase" }}>Bottle or Label Photo</div>
            <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
              <Btn onClick={() => bottleFileRef.current.click()} style={{ background: "#242424", border: "1px dashed #444", color: "#aaa" }}>📷 Take / Upload Photo</Btn>
              {bottleImg && (
                <button onClick={() => setBottleImg(null)} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: "11px", fontFamily: "monospace" }}>Remove</button>
              )}
            </div>
            <input ref={bottleFileRef} type="file" accept="image/*"              onChange={e => { const f = e.target.files[0]; if (!f) return; if (isHeic(f)) { alert(HEIC_MSG); e.target.value = ""; return; } const r = new FileReader(); r.onload = async () => { try { setBottleImg(await compressImage(r.result)); } catch (err) { alert(err.message); } }; r.readAsDataURL(f); e.target.value = ""; }}
              style={{ display: "none" }} />
          </div>
          {bottleImg && (
            <div style={{ display: "flex", gap: "14px", alignItems: "flex-start", flexWrap: "wrap" }}>
              <img src={bottleImg} alt="Bottle" style={{ maxHeight: "200px", maxWidth: "160px", borderRadius: "10px", objectFit: "contain", border: "1px solid #2a2a2a", flexShrink: 0 }} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", minWidth: "120px" }}>
                <div style={{ fontSize: "11px", color: "#4caf79", fontFamily: "monospace", marginBottom: "12px" }}>✓ Photo ready</div>
                <Btn variant="gold" onClick={handleBottleAnalysis} disabled={loading}>Analyse This Wine</Btn>
              </div>
            </div>
          )}
          {!bottleImg && (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Btn variant="gold" onClick={handleBottleAnalysis} disabled={true}>Analyse This Wine</Btn>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes somm-pulse {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
          40%            { opacity: 1;   transform: scale(1.1); }
        }
      `}</style>
    </div>
  );
}

// ─── Scan Bottle Modal ────────────────────────────────────────────

function ScanBottleModal({ onAddToTasting, onAddToCellar, onClose }) {
  const [step, setStep] = useState("capture"); // capture | reading | review
  const [image, setImage] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const fileRef = useRef();

  const readLabel = async (dataUrl) => {
    setStep("reading");
    try {
      const { mediaType, data: imgData } = parseImageDataUrl(dataUrl);
      const raw = await callClaude({
        maxTokens: 600,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imgData } },
          { type: "text", text: `Analyse this wine bottle or label carefully. Return ONLY valid JSON, no markdown:\n{"name":"wine name only (not producer)","producer":"winery or producer name","vintage":2020,"region":"wine region","country":"country of origin","grape":"grape variety or blend","style":"Red|White|Rosé|Sparkling|Dessert|Orange","price":null}\nBe precise. Use null for any field you cannot determine.` }
        ]}],
      });
      setParsed(JSON.parse(raw.replace(/```json|```/g, "").trim()));
    } catch (e) {
      console.error("[ScanBottleModal] Label read error:", e.message);
      setError(`Couldn't read the label: ${e.message}`);
    }
    setStep("review");
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (isHeic(file)) { setError(HEIC_MSG); setStep("review"); e.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try { const compressed = await compressImage(reader.result); setImage(compressed); readLabel(compressed); }
      catch (err) { setError(err.message); setStep("review"); }
    };
    reader.readAsDataURL(file);
  };

  const reset = () => { setStep("capture"); setImage(null); setParsed(null); setError(null); setQuantity(1); };

  const handleAddToCellar = () => {
    onAddToCellar({
      id: `c${Date.now()}`,
      name: parsed?.name || "",
      producer: parsed?.producer || "",
      vintage: parsed?.vintage || null,
      region: parsed?.region || "",
      country: parsed?.country || "Australia",
      grape: parsed?.grape || "",
      style: parsed?.style || "Red",
      quantity,
      drinkFrom: null,
      drinkBy: null,
      price: parsed?.price ? `$${parsed.price}` : "",
      location: "John's Cellar",
      notes: "",
      dateAdded: new Date().toISOString().split("T")[0],
    });
  };

  const handleAddToTasting = () => {
    onAddToTasting({
      name: parsed?.name || "",
      producer: parsed?.producer || "",
      vintage: parsed?.vintage || null,
      region: parsed?.region || "",
      country: parsed?.country || "France",
      grape: parsed?.grape || "",
      style: parsed?.style || "Red",
      label: image,
      date: new Date().toISOString().split("T")[0],
    });
  };

  const [sc, tc] = styleColors[parsed?.style] || ["#222", "#888"];

  return (
    <Modal title="📷 Scan a Bottle" onClose={onClose}>

      {/* ── Step: Capture ── */}
      {step === "capture" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "20px" }}>
          <div
            onClick={() => fileRef.current.click()}
            style={{
              width: "220px", height: "220px", borderRadius: "20px",
              border: "2px dashed #333", background: "#141414",
              display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", gap: "14px", cursor: "pointer",
              transition: "border-color 0.15s",
            }}
            onMouseEnter={e => e.currentTarget.style.borderColor = gold}
            onMouseLeave={e => e.currentTarget.style.borderColor = "#333"}
          >
            <div style={{ fontSize: "52px" }}>📷</div>
            <div style={{ fontSize: "11px", color: "#555", fontFamily: "monospace", textAlign: "center", lineHeight: 1.6 }}>
              Tap to take a photo<br />or upload from your library
            </div>
          </div>
          <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{ display: "none" }} />
          <Btn variant="gold" onClick={() => fileRef.current.click()} style={{ padding: "13px 36px", fontSize: "15px" }}>
            Take / Upload Photo
          </Btn>
        </div>
      )}

      {/* ── Step: Reading ── */}
      {step === "reading" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "24px", padding: "16px 0" }}>
          {image && <img src={image} alt="" style={{ height: "140px", borderRadius: "12px", objectFit: "contain", border: "1px solid #2a2a2a" }} />}
          <div style={{ display: "flex", gap: "7px" }}>
            {[0, 1, 2].map(j => (
              <div key={j} style={{
                width: "9px", height: "9px", borderRadius: "50%", background: gold,
                animation: `somm-pulse 1.2s ease-in-out ${j * 0.2}s infinite`,
              }} />
            ))}
          </div>
          <div style={{ color: "#555", fontFamily: "monospace", fontSize: "12px", letterSpacing: "1px" }}>READING LABEL…</div>
        </div>
      )}

      {/* ── Step: Review ── */}
      {step === "review" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* Wine preview card */}
          {parsed && !error && (
            <div style={{
              background: "#141414", border: "1px solid #2a2a2a",
              borderRadius: "14px", padding: "16px", position: "relative", overflow: "hidden",
            }}>
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "3px", background: tc, opacity: 0.8 }} />
              <div style={{ position: "absolute", top: "14px", right: "14px" }}>
                <Badge label={parsed.style || "Unknown"} color={sc} text={tc} />
              </div>
              <div style={{ display: "flex", gap: "14px", alignItems: "flex-start" }}>
                {image && (
                  <img src={image} alt="" style={{ height: "80px", width: "56px", objectFit: "cover", borderRadius: "8px", border: "1px solid #2a2a2a", flexShrink: 0 }} />
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ color: "#555", fontSize: "11px", fontFamily: "monospace", marginBottom: "2px" }}>
                    {parsed.vintage || "NV"} · {parsed.country || "Unknown"}
                  </div>
                  <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "18px", fontWeight: 700, color: "#f0ebe0", lineHeight: 1.2, paddingRight: "70px", marginBottom: "2px" }}>
                    {parsed.name || "Unknown wine"}
                  </div>
                  <div style={{ color: "#888", fontSize: "12px", marginBottom: "2px" }}>{parsed.producer}</div>
                  <div style={{ color: "#555", fontSize: "11px", fontFamily: "monospace" }}>
                    {[parsed.grape, parsed.region].filter(Boolean).join(" · ")}
                  </div>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div style={{ background: "#1a0808", border: "1px solid #3a1515", borderRadius: "10px", padding: "12px 16px", color: "#c05050", fontSize: "12px", fontFamily: "monospace" }}>
              {error}
            </div>
          )}

          {/* Destination choice */}
          <div style={{ fontSize: "10px", color: "#555", fontFamily: "monospace", letterSpacing: "1px", textTransform: "uppercase" }}>Where would you like to add this wine?</div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            {/* Log Tasting */}
            <button onClick={handleAddToTasting} style={{
              background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "14px",
              padding: "18px 12px", cursor: "pointer", textAlign: "center",
              transition: "border-color 0.15s, background 0.15s",
            }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = blush; e.currentTarget.style.background = "#1e1618"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#2a2a2a"; e.currentTarget.style.background = "#1a1a1a"; }}
            >
              <div style={{ fontSize: "28px", marginBottom: "8px" }}>🍷</div>
              <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "15px", color: "#f0ebe0", marginBottom: "4px" }}>Log Tasting</div>
              <div style={{ fontSize: "10px", color: "#555", fontFamily: "monospace" }}>Add ratings & notes</div>
            </button>

            {/* Add to Cellar */}
            <div style={{
              background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "14px",
              padding: "18px 12px", textAlign: "center",
            }}>
              <div style={{ fontSize: "28px", marginBottom: "8px" }}>🏠</div>
              <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "15px", color: "#f0ebe0", marginBottom: "8px" }}>Add to Cellar</div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", marginBottom: "10px" }}>
                <button onClick={() => setQuantity(q => Math.max(1, q - 1))} style={{ background: "#242424", border: "1px solid #333", borderRadius: "6px", color: "#aaa", width: "28px", height: "28px", cursor: "pointer", fontSize: "16px" }}>−</button>
                <span style={{ fontFamily: "'Playfair Display', serif", fontSize: "20px", color: gold, minWidth: "24px" }}>{quantity}</span>
                <button onClick={() => setQuantity(q => q + 1)} style={{ background: "#242424", border: "1px solid #333", borderRadius: "6px", color: "#aaa", width: "28px", height: "28px", cursor: "pointer", fontSize: "16px" }}>+</button>
              </div>
              <button onClick={handleAddToCellar} style={{
                background: `linear-gradient(135deg, ${gold}, #a07830)`,
                border: "none", borderRadius: "8px", cursor: "pointer",
                fontFamily: "'Playfair Display', serif", fontSize: "13px", fontWeight: 700,
                color: "#fff", padding: "8px 16px", width: "100%",
              }}>
                Publish to Cellar
              </button>
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <Btn onClick={reset}>Retake</Btn>
            <Btn onClick={onClose}>Cancel</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── Splash Screen ────────────────────────────────────────────────

function SplashScreen({ onEnter }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { const t = setTimeout(() => setVisible(true), 50); return () => clearTimeout(t); }, []);

  const handleEnter = () => {
    setVisible(false);
    setTimeout(onEnter, 700);
  };

  const rows = 14;
  const vp = { x: 400, y: 210 };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 2000, overflow: "hidden",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      opacity: visible ? 1 : 0, transition: "opacity 0.7s ease",
    }}>
      {/* Sky gradient */}
      <div style={{
        position: "absolute", inset: 0,
        background: "linear-gradient(180deg, #04050e 0%, #0a0818 18%, #1a0e08 42%, #0e1a06 62%, #060e04 100%)",
      }} />

      {/* Stars */}
      {[...Array(60)].map((_, i) => {
        const x = (i * 137.5) % 100;
        const y = (i * 97.3) % 45;
        const size = i % 5 === 0 ? 1.5 : 0.8;
        return (
          <div key={i} style={{
            position: "absolute", borderRadius: "50%",
            left: `${x}%`, top: `${y}%`,
            width: `${size}px`, height: `${size}px`,
            background: "#fff", opacity: 0.2 + (i % 4) * 0.15,
          }} />
        );
      })}

      {/* Vineyard SVG */}
      <svg viewBox="0 0 800 450" preserveAspectRatio="xMidYMax slice"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>

        {/* Horizon glow */}
        <defs>
          <radialGradient id="hglow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#c9a84c" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#c9a84c" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1a0e08" stopOpacity="0" />
            <stop offset="100%" stopColor="#0a1206" stopOpacity="1" />
          </linearGradient>
        </defs>
        <ellipse cx="400" cy="210" rx="320" ry="60" fill="url(#hglow)" />

        {/* Horizon line */}
        <line x1="0" y1="210" x2="800" y2="210" stroke="#c9a84c" strokeOpacity="0.25" strokeWidth="1" />

        {/* Perspective vineyard rows */}
        {[...Array(rows)].map((_, i) => {
          const t = (i + 1) / rows;
          const y = vp.y + t * t * 240;
          const halfW = t * t * 480;
          const x1 = vp.x - halfW;
          const x2 = vp.x + halfW;
          const postCount = Math.max(2, Math.floor(t * 10));
          return (
            <g key={i}>
              <line x1={x1} y1={y} x2={x2} y2={y}
                stroke="#4a7a30" strokeOpacity={0.2 + t * 0.5} strokeWidth={0.5 + t * 2.5} />
              {[...Array(postCount + 1)].map((_, j) => {
                const px = x1 + (j / postCount) * (x2 - x1);
                const ph = 6 + t * 14;
                return (
                  <line key={j} x1={px} y1={y - ph * 0.7} x2={px} y2={y + ph * 0.3}
                    stroke="#3a6020" strokeOpacity={0.35 + t * 0.3} strokeWidth={0.8} />
                );
              })}
            </g>
          );
        })}

        {/* Converging perspective lines */}
        {[...Array(11)].map((_, i) => {
          const angle = -55 + i * 11;
          const rad = (angle * Math.PI) / 180;
          return (
            <line key={i}
              x1={vp.x} y1={vp.y}
              x2={vp.x + Math.cos(rad) * 700}
              y2={vp.y + Math.abs(Math.sin(rad)) * 700}
              stroke="#4a7a30" strokeOpacity="0.08" strokeWidth="1" />
          );
        })}

        {/* Ground fill */}
        <polygon
          points={`0,450 800,450 800,${vp.y} 0,${vp.y}`}
          fill="url(#skyGrad)" />
      </svg>

      {/* Content */}
      <div style={{ position: "relative", textAlign: "center", padding: "0 24px" }}>
        <div style={{
          fontSize: "11px", letterSpacing: "6px", color: gold,
          fontFamily: "monospace", marginBottom: "18px", opacity: 0.85,
        }}>
          JM & NICKY
        </div>
        <div style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: "clamp(44px, 9vw, 84px)",
          fontWeight: 900, color: "#f0ebe0", lineHeight: 1,
          marginBottom: "14px",
          textShadow: "0 2px 40px rgba(0,0,0,0.9)",
        }}>
          The Cellar Book
        </div>
        <div style={{
          fontSize: "11px", color: "#555", fontFamily: "monospace",
          letterSpacing: "3px", marginBottom: "52px",
        }}>
          HUNTER VALLEY · AUSTRALIA
        </div>
        <button onClick={handleEnter} style={{
          background: `linear-gradient(135deg, ${gold}, #a07830)`,
          border: "none", borderRadius: "50px", cursor: "pointer",
          fontFamily: "'Playfair Display', serif", fontSize: "17px", fontWeight: 700,
          color: "#fff", padding: "15px 44px",
          boxShadow: "0 4px 24px rgba(201,168,76,0.35)",
          transition: "transform 0.15s, box-shadow 0.15s",
        }}
          onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 8px 32px rgba(201,168,76,0.5)"; }}
          onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = "0 4px 24px rgba(201,168,76,0.35)"; }}
        >
          Enter the Cellar
        </button>
      </div>

      {/* Vignette overlay */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background: "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.7) 100%)",
      }} />
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────

export default function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [tab, setTab] = useState("tastings");
  const [tastings, setTastings] = useState([]);
  const [cellar, setCellar] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [syncStatus, setSyncStatus] = useState("loading"); // "loading" | "syncing" | "synced" | "error"
  const [syncError, setSyncError] = useState(null);

  const [showScanModal, setShowScanModal] = useState(false);
  const [showTastingForm, setShowTastingForm] = useState(false);
  const [editTasting, setEditTasting] = useState(null);
  const [viewTasting, setViewTasting] = useState(null);
  const [showCellarForm, setShowCellarForm] = useState(false);
  const [editCellar, setEditCellar] = useState(null);
  const [viewCellar, setViewCellar] = useState(null);

  const [tFilter, setTFilter] = useState("All");
  const [tSort, setTSort] = useState("date");
  const [tSearch, setTSearch] = useState("");
  const [cSearch, setCSearch] = useState("");

  // Load from Google Sheets on mount
  useEffect(() => {
    (async () => {
      try {
        const [t, c] = await Promise.all([sheetsGet("tastings"), sheetsGet("cellar")]);
        const hasT = Array.isArray(t) && t.length > 0;
        const hasC = Array.isArray(c) && c.length > 0;
        // Google Sheets is the source of truth — always use its data if available
        setTastings(hasT ? t.map(fromSheetTasting) : SEED_TASTINGS);
        setCellar(hasC ? c.map(fromSheetCellar) : SEED_CELLAR);
        // First run: seed the sheets with default data
        if (!hasT) sheetsReplace("tastings", SEED_TASTINGS.map(toSheetTasting)).catch(console.error);
        if (!hasC) sheetsReplace("cellar", SEED_CELLAR).catch(console.error);
        setSyncStatus("synced");
        setSyncError(null);
      } catch (e) {
        console.error("[load] Failed to fetch from Google Sheets:", e.message);
        setTastings([]);
        setCellar([]);
        setSyncStatus("error");
        setSyncError(e.message);
      }
      setLoaded(true);
    })();
  }, []);

  const syncWrap = (fn) => {
    setSyncStatus("syncing");
    fn().then(() => { setSyncStatus("synced"); setSyncError(null); }).catch(e => {
      console.error("[sync]", e.message);
      setSyncStatus("error");
      setSyncError(e.message);
    });
  };

  // Tastings actions
  const saveTasting = async (w) => {
    setTastings(ts => w.id && ts.find(t => t.id === w.id) ? ts.map(t => t.id === w.id ? w : t) : [w, ...ts]);
    setShowTastingForm(false); setEditTasting(null);
    const thumbnail = w.label ? await compressForSheet(w.label) : null;
    syncWrap(() => sheetsUpsert("tastings", { ...w, label: thumbnail }));
  };
  const deleteTasting = (id) => {
    if (!confirm("Remove this tasting?")) return;
    setTastings(ts => ts.filter(t => t.id !== id));
    syncWrap(() => sheetsDelete("tastings", id));
  };

  // Cellar actions
  const saveCellar = async (w) => {
    setCellar(cs => w.id && cs.find(c => c.id === w.id) ? cs.map(c => c.id === w.id ? w : c) : [w, ...cs]);
    setShowCellarForm(false); setEditCellar(null);
    const thumbnail = w.label ? await compressForSheet(w.label) : null;
    syncWrap(() => sheetsUpsert("cellar", { ...w, label: thumbnail }));
  };
  const deleteCellar = (id) => {
    if (!confirm("Remove from cellar?")) return;
    setCellar(cs => cs.filter(c => c.id !== id));
    syncWrap(() => sheetsDelete("cellar", id));
  };
  const adjustQty = (id, delta) => {
    const item = cellar.find(c => c.id === id);
    if (!item) return;
    const updated = { ...item, quantity: Math.max(0, (item.quantity || 0) + delta) };
    setCellar(cs => cs.map(c => c.id === id ? updated : c));
    syncWrap(() => sheetsUpsert("cellar", updated));
  };

  // Scan bottle handlers
  const handleScanToTasting = (wineData) => {
    setEditTasting(wineData);
    setShowTastingForm(true);
    setShowScanModal(false);
  };
  const handleScanToCellar = (entry) => {
    setCellar(cs => [entry, ...cs]);
    setShowScanModal(false);
    syncWrap(() => sheetsUpsert("cellar", entry));
  };

  const filteredTastings = tastings
    .filter(w => tFilter === "All" || w.style === tFilter)
    .filter(w => !tSearch || `${w.name} ${w.producer} ${w.region} ${w.grape}`.toLowerCase().includes(tSearch.toLowerCase()))
    .sort((a, b) => {
      if (tSort === "date") return new Date(b.date || 0) - new Date(a.date || 0);
      if (tSort === "avg") {
        const ba = (b.jmRating ?? 0 + b.nickyRating ?? 0) / 2;
        const aa = (a.jmRating ?? 0 + a.nickyRating ?? 0) / 2;
        return ba - aa;
      }
      if (tSort === "vintage") return (b.vintage || 0) - (a.vintage || 0);
      return 0;
    });

  const filteredCellar = cellar
    .filter(w => !cSearch || `${w.name} ${w.producer} ${w.region}`.toLowerCase().includes(cSearch.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  const totalBottles = cellar.reduce((s, w) => s + (w.quantity || 0), 0);
  const avgJM = tastings.filter(w => w.jmRating).length
    ? (tastings.filter(w => w.jmRating).reduce((s, w) => s + w.jmRating, 0) / tastings.filter(w => w.jmRating).length).toFixed(1) : "—";
  const avgNicky = tastings.filter(w => w.nickyRating).length
    ? (tastings.filter(w => w.nickyRating).reduce((s, w) => s + w.nickyRating, 0) / tastings.filter(w => w.nickyRating).length).toFixed(1) : "—";

  const [bulkH, setBulkH] = useState(null); // null | { done, total, log[] }

  const populateAllHalliday = async () => {
    const missing = [
      ...tastings.filter(w => w.hallidayRating == null).map(w => ({ ...w, _sheet: "tastings" })),
      ...cellar.filter(w => w.hallidayRating == null).map(w => ({ ...w, _sheet: "cellar" })),
    ];
    if (!missing.length) { setBulkH({ done: 0, total: 0, log: ["All wines already have Halliday scores."] }); return; }
    setBulkH({ done: 0, total: missing.length, log: [] });

    for (let i = 0; i < missing.length; i++) {
      const { _sheet, ...w } = missing[i];
      const score = await lookupHalliday(w.name, w.producer, w.vintage);
      const entry = score != null
        ? `✓ ${w.producer ? w.producer + " " : ""}${w.name}${w.vintage ? " " + w.vintage : ""}: ${score}`
        : `— ${w.producer ? w.producer + " " : ""}${w.name}${w.vintage ? " " + w.vintage : ""}: not found`;

      if (score != null) {
        const updated = { ...w, hallidayRating: score };
        if (_sheet === "tastings") {
          setTastings(ts => ts.map(t => t.id === w.id ? updated : t));
          const thumb = updated.label ? await compressForSheet(updated.label) : null;
          sheetsUpsert("tastings", { ...updated, label: thumb }).catch(console.error);
        } else {
          setCellar(cs => cs.map(c => c.id === w.id ? updated : c));
          const thumb = updated.label ? await compressForSheet(updated.label) : null;
          sheetsUpsert("cellar", { ...updated, label: thumb }).catch(console.error);
        }
      }

      setBulkH(prev => ({ ...prev, done: i + 1, log: [...prev.log, entry] }));
      if (i < missing.length - 1) await new Promise(r => setTimeout(r, 400));
    }
  };

  if (!loaded) return (
    <div style={{ minHeight: "100vh", background: "#111", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#555", fontFamily: "monospace", fontSize: "13px" }}>Loading your cellar…</div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#111", color: "#f0ebe0" }}>
      <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&display=swap" rel="stylesheet" />
      {showSplash && <SplashScreen onEnter={() => setShowSplash(false)} />}

      {/* Header */}
      <div style={{ background: "#0d0d0d", borderBottom: "1px solid #1a1a1a", padding: "28px 20px 0" }}>
        <div style={{ maxWidth: "900px", margin: "0 auto", position: "relative" }}>
          <div style={{ textAlign: "center", marginBottom: "20px" }}>
            <div style={{ position: "absolute", top: "0", right: "0", display: "flex", alignItems: "center", gap: "5px" }}>
              {syncStatus === "syncing" && <span style={{ fontSize: "10px", color: "#555", fontFamily: "monospace" }}>⟳ syncing…</span>}
              {syncStatus === "synced"  && <span style={{ fontSize: "10px", color: "#4caf79", fontFamily: "monospace" }}>● synced</span>}
              {syncStatus === "error"   && <span style={{ fontSize: "10px", color: "#c94c4c", fontFamily: "monospace", cursor: "help" }} title={syncError || "Sync error — check Vercel env vars"}>✕ sync error</span>}
            </div>
            <div style={{ fontSize: "10px", letterSpacing: "4px", color: gold, fontFamily: "monospace", marginBottom: "6px" }}>JM & NICKY</div>
            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "clamp(28px, 5vw, 44px)", fontWeight: 900, color: "#f0ebe0", lineHeight: 1 }}>The Cellar Book</div>
            <div style={{ fontSize: "11px", color: "#444", fontFamily: "monospace", marginTop: "6px" }}>A personal wine journal</div>
            <div style={{ display: "flex", justifyContent: "center", gap: "28px", marginTop: "18px", flexWrap: "wrap" }}>
              {[["Tastings", tastings.length, "#f0ebe0"], ["JM Avg", avgJM, gold], ["Nicky Avg", avgNicky, blush], ["Bottles", totalBottles, "#f0ebe0"]].map(([l, v, c]) => (
                <div key={l} style={{ textAlign: "center" }}>
                  <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "26px", fontWeight: 700, color: c }}>{v}</div>
                  <div style={{ fontSize: "9px", color: "#444", fontFamily: "monospace", letterSpacing: "1px", textTransform: "uppercase" }}>{l}</div>
                </div>
              ))}
            </div>
          </div>
          <TabBar active={tab} onChange={setTab} />
        </div>
      </div>

      {/* Tastings tab */}
      {tab === "tastings" && (
        <div style={{ maxWidth: "900px", margin: "0 auto", padding: "20px" }}>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "20px", alignItems: "center" }}>
            <input value={tSearch} onChange={e => setTSearch(e.target.value)} placeholder="Search tastings…"
              style={{ background: "#1a1a1a", border: "1px solid #2e2e2e", borderRadius: "10px", padding: "9px 14px", color: "#f0ebe0", fontSize: "13px", fontFamily: "monospace", outline: "none", flex: 1, minWidth: "160px" }} />
            <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
              {["All", ...STYLES].map(s => (
                <button key={s} onClick={() => setTFilter(s)} style={{
                  background: tFilter === s ? gold : "#1a1a1a", border: `1px solid ${tFilter === s ? gold : "#2e2e2e"}`,
                  borderRadius: "20px", padding: "5px 12px", color: tFilter === s ? "#111" : "#888",
                  cursor: "pointer", fontSize: "11px", fontFamily: "monospace", fontWeight: tFilter === s ? 700 : 400,
                }}>{s}</button>
              ))}
            </div>
            <select value={tSort} onChange={e => setTSort(e.target.value)} style={{ background: "#1a1a1a", border: "1px solid #2e2e2e", borderRadius: "10px", padding: "9px 12px", color: "#888", fontSize: "11px", fontFamily: "monospace", outline: "none" }}>
              <option value="date">Recent</option>
              <option value="avg">Rating</option>
              <option value="vintage">Vintage</option>
            </select>
            <Btn variant="gold" onClick={() => { setEditTasting(null); setShowTastingForm(true); }}>+ Log Tasting</Btn>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "16px" }}>
            {filteredTastings.length === 0 && (
              <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "60px 20px", color: "#444", fontFamily: "'Playfair Display', serif", fontSize: "18px" }}>
                No tastings yet. Log your first wine! 🍷
              </div>
            )}
            {filteredTastings.map(w => (
              <TastingCard key={w.id} wine={w} onView={() => setViewTasting(w)} />
            ))}
          </div>
        </div>
      )}

      {/* Cellar tab */}
      {tab === "cellar" && (
        <div style={{ maxWidth: "900px", margin: "0 auto", padding: "20px" }}>
          <div style={{ display: "flex", gap: "10px", marginBottom: "20px", alignItems: "center", flexWrap: "wrap" }}>
            <input value={cSearch} onChange={e => setCSearch(e.target.value)} placeholder="Search cellar…"
              style={{ background: "#1a1a1a", border: "1px solid #2e2e2e", borderRadius: "10px", padding: "9px 14px", color: "#f0ebe0", fontSize: "13px", fontFamily: "monospace", outline: "none", flex: 1, minWidth: "160px" }} />
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <div style={{ fontFamily: "'Playfair Display', serif", fontSize: "18px", color: gold }}>{totalBottles} bottles</div>
              <Btn variant="gold" onClick={() => { setEditCellar(null); setShowCellarForm(true); }}>+ Add Bottle</Btn>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {filteredCellar.length === 0 && (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "#444", fontFamily: "'Playfair Display', serif", fontSize: "18px" }}>
                Your cellar is empty. Start adding bottles! 🍾
              </div>
            )}
            {filteredCellar.map(w => (
              <CellarRow key={w.id} wine={w} onView={() => setViewCellar(w)} onQty={adjustQty} />
            ))}
          </div>
        </div>
      )}

      {/* Stats tab */}
      {tab === "stats" && <Stats tastings={tastings} cellar={cellar} bulkH={bulkH} onPopulateHalliday={populateAllHalliday} onResetBulk={() => setBulkH(null)} />}

      {/* Sommelier tab */}
      {tab === "sommelier" && <Sommelier tastings={tastings} />}

      {/* Floating scan button */}
      {!showSplash && (
        <button
          onClick={() => setShowScanModal(true)}
          title="Scan a bottle"
          style={{
            position: "fixed", bottom: "calc(24px + env(safe-area-inset-bottom, 0px))", right: "20px", zIndex: 500,
            width: "56px", height: "56px", borderRadius: "50%",
            background: `linear-gradient(135deg, ${gold}, #a07830)`,
            border: "none", cursor: "pointer", fontSize: "22px",
            boxShadow: "0 4px 20px rgba(201,168,76,0.45)",
            transition: "transform 0.15s, box-shadow 0.15s",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.1)"; e.currentTarget.style.boxShadow = "0 6px 28px rgba(201,168,76,0.6)"; }}
          onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = "0 4px 20px rgba(201,168,76,0.45)"; }}
        >📷</button>
      )}

      {/* Modals */}
      {showScanModal && (
        <ScanBottleModal
          onAddToTasting={handleScanToTasting}
          onAddToCellar={handleScanToCellar}
          onClose={() => setShowScanModal(false)}
        />
      )}
      {viewTasting && (
        <TastingDetail
          wine={viewTasting}
          onClose={() => setViewTasting(null)}
          onEdit={w => { setViewTasting(null); setEditTasting(w); setShowTastingForm(true); }}
          onDelete={id => { setViewTasting(null); deleteTasting(id); }}
          onFindLabel={async (w) => {
            const dataUrl = await searchWineImage(w.name, w.producer);
            if (!dataUrl) return false;
            const thumbnail = await compressForSheet(dataUrl);
            const updated = { ...w, label: dataUrl };
            setTastings(ts => ts.map(t => t.id === w.id ? updated : t));
            setViewTasting(updated);
            syncWrap(() => sheetsUpsert("tastings", { ...updated, label: thumbnail }));
            return true;
          }}
          onFindHalliday={async (w) => {
            const score = await lookupHalliday(w.name, w.producer, w.vintage);
            if (score == null) return null;
            const updated = { ...w, hallidayRating: score };
            setTastings(ts => ts.map(t => t.id === w.id ? updated : t));
            setViewTasting(updated);
            const thumbnail = updated.label ? await compressForSheet(updated.label) : null;
            syncWrap(() => sheetsUpsert("tastings", { ...updated, label: thumbnail }));
            return score;
          }}
        />
      )}
      {showTastingForm && (
        <TastingForm wine={editTasting} onSave={saveTasting} onCancel={() => { setShowTastingForm(false); setEditTasting(null); }} />
      )}
      {viewCellar && (
        <CellarDetail
          wine={viewCellar}
          onClose={() => setViewCellar(null)}
          onEdit={w => { setViewCellar(null); setEditCellar(w); setShowCellarForm(true); }}
          onDelete={id => { setViewCellar(null); deleteCellar(id); }}
          onQty={(id, delta) => { adjustQty(id, delta); setViewCellar(c => ({ ...c, quantity: Math.max(0, (c.quantity || 0) + delta) })); }}
          onFindHalliday={async (w) => {
            const score = await lookupHalliday(w.name, w.producer, w.vintage);
            if (score == null) return null;
            const updated = { ...w, hallidayRating: score };
            setCellar(cs => cs.map(c => c.id === w.id ? updated : c));
            setViewCellar(updated);
            const thumbnail = updated.label ? await compressForSheet(updated.label) : null;
            syncWrap(() => sheetsUpsert("cellar", { ...updated, label: thumbnail }));
            return score;
          }}
        />
      )}
      {showCellarForm && (
        <CellarForm wine={editCellar} onSave={saveCellar} onCancel={() => { setShowCellarForm(false); setEditCellar(null); }} />
      )}
    </div>
  );
}
