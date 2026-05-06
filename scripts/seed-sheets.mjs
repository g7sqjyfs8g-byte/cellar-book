// Pushes all seed data to Google Sheets via the Apps Script Web App.
// Usage: node scripts/seed-sheets.mjs
// Requires GOOGLE_SHEET_URL and SHEETS_SECRET in .env.local

import { readFileSync } from "fs";
import { resolve } from "path";

// Parse .env.local
const envPath = resolve(process.cwd(), ".env.local");
const envVars = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const url    = envVars.GOOGLE_SHEET_URL;
const secret = envVars.SHEETS_SECRET;

if (!url || url.includes("your-apps-script")) {
  console.error("❌  Set GOOGLE_SHEET_URL in .env.local first.");
  process.exit(1);
}
if (!secret || secret.includes("your-secret")) {
  console.error("❌  Set SHEETS_SECRET in .env.local first.");
  process.exit(1);
}

// ── Seed data ────────────────────────────────────────────────────────────────

const TASTINGS = [
  { id:"t1", name:"Petit Chablis", producer:"Christophe Patrice", vintage:2024, region:"Chablis, Burgundy", country:"France", grape:"Chardonnay", style:"White", jmRating:8.5, nickyRating:8.5, notes:"Bone dry, high acid, flinty minerality. Perfect with seafood.", pairing:"Seafood at Que Sera", price:"", location:"Que Sera Food & Wine Bar", buyAgain:true, date:"2026-05-02" },
  { id:"t2", name:"Bremley Gamay", producer:"Bremley", vintage:2024, region:"Coal River, TAS", country:"Australia", grape:"Gamay", style:"Red", jmRating:null, nickyRating:null, notes:"Tried at lunch — verdict pending.", pairing:"Seafood", price:"$72", location:"Restaurant", buyAgain:null, date:"2026-05-02" },
];

const CELLAR = [
  { id:"c1",  name:"Elderton Command Barossa Shiraz",                              producer:"Elderton",              vintage:2017, region:"Barossa Valley", country:"Australia", grape:"Shiraz",                                        style:"Red", quantity:1, drinkFrom:null, drinkBy:2037, price:"$150", location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c2",  name:"Jacaranda Ridge Coonawarra Cabernet Sauvignon",                producer:"Orlando",               vintage:2015, region:"Coonawarra",     country:"Australia", grape:"Cabernet Sauvignon",                            style:"Red", quantity:1, drinkFrom:null, drinkBy:2040, price:"$70",  location:"John's Cellar", notes:"Gift from Tim Micallef", dateAdded:"2026-01-01" },
  { id:"c3",  name:"Bin 150 Marananga Barossa Valley Shiraz",                      producer:"Penfolds",              vintage:2019, region:"Barossa Valley", country:"Australia", grape:"Shiraz",                                        style:"Red", quantity:1, drinkFrom:null, drinkBy:2039, price:"$100", location:"John's Cellar", notes:"Gift",                  dateAdded:"2026-01-01" },
  { id:"c4",  name:"Bin 150 Marananga Shiraz",                                     producer:"Penfolds",              vintage:2021, region:"Barossa Valley", country:"Australia", grape:"Shiraz",                                        style:"Red", quantity:1, drinkFrom:null, drinkBy:2045, price:"$100", location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c5",  name:"St Henri Shiraz",                                               producer:"Penfolds",              vintage:2017, region:"McLaren Vale",   country:"Australia", grape:"Shiraz",                                        style:"Red", quantity:1, drinkFrom:null, drinkBy:2047, price:"$130", location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c6",  name:"St Henri Shiraz",                                               producer:"Penfolds",              vintage:2020, region:"McLaren Vale",   country:"Australia", grape:"Shiraz",                                        style:"Red", quantity:1, drinkFrom:null, drinkBy:2045, price:"$136", location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c7",  name:"Single Vineyard Reserve Coquun Hunter Valley Shiraz",           producer:"Pepper Tree Wines",     vintage:2017, region:"Hunter Valley",  country:"Australia", grape:"Shiraz",                                        style:"Red", quantity:6, drinkFrom:null, drinkBy:2036, price:"$90",  location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c8",  name:"Limited Release BDX-4",                                         producer:"Pepper Tree Wines",     vintage:2022, region:"Wrattonbully",   country:"Australia", grape:"Cabernet Sauvignon Merlot Malbec Petit Verdot", style:"Red", quantity:1, drinkFrom:null, drinkBy:2032, price:"$50",  location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c9",  name:"Limited Release Red Hill Hunter Valley Shiraz",                 producer:"Pepper Tree Wines",     vintage:2019, region:"Hunter Valley",  country:"Australia", grape:"Shiraz",                                        style:"Red", quantity:2, drinkFrom:null, drinkBy:2028, price:"$50",  location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c10", name:"Premium Reserve Block 21A Cabernet Sauvignon",                  producer:"Pepper Tree Wines",     vintage:2018, region:"Wrattonbully",   country:"Australia", grape:"Cabernet Sauvignon",                            style:"Red", quantity:1, drinkFrom:null, drinkBy:2032, price:"$60",  location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c11", name:"Single Vineyard Elderslee Road Reserve Cabernet Sauvignon",     producer:"Pepper Tree Wines",     vintage:2018, region:"Wrattonbully",   country:"Australia", grape:"Cabernet Sauvignon",                            style:"Red", quantity:1, drinkFrom:null, drinkBy:2028, price:"$50",  location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c12", name:"Single Vineyard Premium Reserve The Gravels Shiraz",            producer:"Pepper Tree Wines",     vintage:2019, region:"Wrattonbully",   country:"Australia", grape:"Shiraz",                                        style:"Red", quantity:3, drinkFrom:null, drinkBy:2029, price:"$50",  location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c13", name:"Single Vineyard Strandlines Reserve Cabernet Shiraz",           producer:"Pepper Tree Wines",     vintage:2019, region:"Wrattonbully",   country:"Australia", grape:"Cabernet Shiraz",                               style:"Red", quantity:2, drinkFrom:null, drinkBy:2033, price:"$60",  location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c14", name:"Stonewell Barossa Shiraz",                                      producer:"Peter Lehmann",         vintage:2013, region:"Barossa Valley", country:"Australia", grape:"Shiraz",                                        style:"Red", quantity:1, drinkFrom:null, drinkBy:2045, price:"$75",  location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c15", name:"Ridge of Tears",                                                producer:"Logan Wines",           vintage:2018, region:"",               country:"Australia", grape:"Shiraz",                                        style:"Red", quantity:1, drinkFrom:null, drinkBy:2026, price:"$45",  location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c16", name:"The Kinnear Mudgee Shiraz Cabernet",                            producer:"Robert Stein Vineyard", vintage:2017, region:"Mudgee",         country:"Australia", grape:"Shiraz Cabernet",                               style:"Red", quantity:3, drinkFrom:null, drinkBy:2027, price:"$90",  location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c17", name:"The Factor",                                                    producer:"Torbreck Vintners",     vintage:2020, region:"Barossa Valley", country:"Australia", grape:"Shiraz",                                        style:"Red", quantity:1, drinkFrom:null, drinkBy:2043, price:"$150", location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c18", name:"The Struie",                                                    producer:"Torbreck Vintners",     vintage:2021, region:"Barossa Valley", country:"Australia", grape:"Shiraz",                                        style:"Red", quantity:1, drinkFrom:null, drinkBy:2038, price:"$60",  location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c19", name:"Jack Roth Mudgee Shiraz",                                       producer:"Yeates Wines",          vintage:2017, region:"Mudgee",         country:"Australia", grape:"Shiraz",                                        style:"Red", quantity:3, drinkFrom:null, drinkBy:2030, price:"$35",  location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
  { id:"c20", name:"Mudgee Cabernet Sauvignon",                                     producer:"Yeates Wines",          vintage:2018, region:"Mudgee",         country:"Australia", grape:"Cabernet Sauvignon",                            style:"Red", quantity:3, drinkFrom:null, drinkBy:2025, price:"$65",  location:"John's Cellar", notes:"",                      dateAdded:"2026-01-01" },
];

// ── Push to sheets ────────────────────────────────────────────────────────────

async function replace(sheet, rows) {
  const res = await fetch(url, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "replace", sheet, rows, secret }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (data.error) throw new Error(data.error);
  return data;
}

console.log("Syncing to Google Sheets…\n");

try {
  process.stdout.write("  Tastings… ");
  await replace("tastings", TASTINGS);
  console.log(`✓  ${TASTINGS.length} rows written`);

  process.stdout.write("  Cellar…   ");
  await replace("cellar", CELLAR);
  console.log(`✓  ${CELLAR.length} rows written`);

  console.log("\nDone. Open your Google Sheet to verify.");
} catch (e) {
  console.error("\n❌ Sync failed:", e.message);
  process.exit(1);
}
