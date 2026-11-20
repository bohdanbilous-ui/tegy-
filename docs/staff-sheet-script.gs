// Apps Script для таблиці «Fincore ERP Staff» (Розширення → Apps Script).
// Властивість скрипта STAFF_SECRET (Налаштування проєкту → Властивості скрипта) = той самий рядок,
// що й STAFF_SHEET_SECRET у Vercel (від 16 символів). Розгортання: Веб-застосунок, виконувати від свого
// імені, доступ «Будь-хто» → адресу вставити у STAFF_SHEET_URL.
function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  var key = PropertiesService.getScriptProperties().getProperty("STAFF_SECRET");
  if (!key || body.key !== key) return out({ error: "Невірний ключ." });
  if (body.action !== "staff") return out({ error: "Невідома дія." });
  var sh = SpreadsheetApp.getActive().getSheetByName(body.sheet || "Співробітники");
  if (!sh) return out({ error: "Немає аркуша «" + (body.sheet || "Співробітники") + "»." });
  return out({ rows: sh.getDataRange().getDisplayValues() });
}
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
