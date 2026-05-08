// ─── The Cellar Book — Google Apps Script ────────────────────────────────────
//
// SETUP STEPS:
// 1. Create a new Google Sheet (or open an existing one)
// 2. Extensions → Apps Script
// 3. Paste this entire file, replacing the default code, then Save
// 4. Run setupSheets() once (select it from the function dropdown, click Run)
//    This creates Tastings and Cellar sheets with the right column headers.
// 5. Deploy → New deployment → Web App
//    - Execute as: Me
//    - Who has access: Anyone
//    Click Deploy and copy the Web App URL.
// 6. Project Settings (gear icon) → Script Properties → Add property:
//    Name: SHEETS_SECRET  Value: (any secret string you choose — e.g. a long random password)
// 7. Add these two environment variables to your Vercel project:
//    GOOGLE_SHEETS_URL    = (the Web App URL from step 5)
//    GOOGLE_SHEETS_SECRET = (the same secret string from step 6)
// 8. Redeploy on Vercel for the new env vars to take effect.
//
// ─────────────────────────────────────────────────────────────────────────────

function doGet(e) {
  if (!checkSecret(e.parameter.secret)) return respond({ error: "Unauthorized" });
  const sheet = getSheet(e.parameter.sheet);
  if (!sheet) return respond([]);
  return respond(readRows(sheet));
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch { return respond({ error: "Invalid JSON" }); }
  if (!checkSecret(body.secret)) return respond({ error: "Unauthorized" });

  const sheet = getSheet(body.sheet);
  if (!sheet) return respond({ error: "Sheet not found: " + body.sheet });

  if (body.action === "upsert")   upsertRow(sheet, body.row);
  else if (body.action === "delete")  deleteRowById(sheet, body.id);
  else if (body.action === "replace") replaceAllRows(sheet, body.rows);
  else return respond({ error: "Unknown action: " + body.action });

  return respond({ ok: true });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function checkSecret(incoming) {
  const stored = PropertiesService.getScriptProperties().getProperty("SHEETS_SECRET");
  return stored && incoming === stored;
}

function getSheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function respond(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function readRows(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0].map(String);
  return data.slice(1)
    .filter(row => row.some(cell => cell !== "" && cell !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        const v = row[i];
        obj[h] = (v === "" || v === null || v === undefined) ? null : v;
      });
      return obj;
    });
}

function getHeaders(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
}

function rowToArray(headers, row) {
  return headers.map(h => {
    const v = row[h];
    return (v === null || v === undefined) ? "" : v;
  });
}

function upsertRow(sheet, row) {
  const headers = getHeaders(sheet);
  const idIdx = headers.indexOf("id");
  if (idIdx === -1) return;
  const rowArr = rowToArray(headers, row);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const ids = sheet.getRange(2, idIdx + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(row.id)) {
        sheet.getRange(i + 2, 1, 1, headers.length).setValues([rowArr]);
        return;
      }
    }
  }
  sheet.appendRow(rowArr);
}

function deleteRowById(sheet, id) {
  const headers = getHeaders(sheet);
  const idIdx = headers.indexOf("id");
  if (idIdx === -1) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const ids = sheet.getRange(2, idIdx + 1, lastRow - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === String(id)) {
      sheet.deleteRow(i + 2);
      return;
    }
  }
}

function replaceAllRows(sheet, rows) {
  if (!rows || !rows.length) return;
  const headers = getHeaders(sheet);
  if (sheet.getLastRow() > 1) sheet.deleteRows(2, sheet.getLastRow() - 1);
  const data = rows.map(row => rowToArray(headers, row));
  sheet.getRange(2, 1, data.length, headers.length).setValues(data);
}

// ── Run once to initialise the spreadsheet ────────────────────────────────────

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let t = ss.getSheetByName("Tastings");
  if (!t) t = ss.insertSheet("Tastings");
  if (t.getLastRow() === 0) {
    const headers = ["id","name","producer","vintage","region","country","grape","style",
                     "jmRating","nickyRating","notes","pairing","price","location","buyAgain","date","label"];
    t.appendRow(headers);
    t.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  }

  let c = ss.getSheetByName("Cellar");
  if (!c) c = ss.insertSheet("Cellar");
  if (c.getLastRow() === 0) {
    const headers = ["id","name","producer","vintage","region","country","grape","style",
                     "quantity","drinkFrom","drinkBy","price","location","notes","dateAdded","label"];
    c.appendRow(headers);
    c.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  }

  Logger.log("Done. Sheets are ready. Now deploy as a Web App.");
}
