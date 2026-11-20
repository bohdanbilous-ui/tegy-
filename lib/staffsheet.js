// Google Таблиця «Fincore ERP Staff» → довідник людей. Лише читання.
// Аркуш «Співробітники»: ПІБ, ІПН, Статус, Дата прийому, Дата звільнення, Посада, Відділ,
// Підрозділ, Категорія (id), Категорія, У PeopleForce, id.
// Основний спосіб: Apps Script у самій таблиці (STAFF_SHEET_URL + STAFF_SHEET_SECRET, або ZP_SHEET_SECRET) —
// той самий патерн, що й для тегів і відомостей. Запасні: GOOGLE_SERVICE_ACCOUNT_JSON (ключ сервісного акаунта, якому дано доступ до таблиці) —
// читаємо через Sheets API. Без неї — запасний варіант: таблиця відкрита «Будь-хто з посиланням».
// Результат — той самий формат, що й у normalize() з peopleforce.js, тож далі працює applyPeople.
import crypto from "crypto";
import { cleanInn } from "./peopleforce";

const DEFAULT_ID = "1zoLbOhdOZy-MoIXeWf6OxHYtwJQZNQpKz0fDk58NZis";
const sheetId = () => (process.env.STAFF_SHEET_ID || DEFAULT_ID).trim();
const sheetName = () => (process.env.STAFF_SHEET_NAME || "Співробітники").trim();

// Джерело за замовчуванням — таблиця; STAFF_SOURCE=peopleforce повертає прямий імпорт з PeopleForce.
export const staffFromSheet = () => (process.env.STAFF_SOURCE || "sheet").trim().toLowerCase() !== "peopleforce";

// Мінімальний CSV-парсер: лапки, коми й переноси рядків усередині клітинок.
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  const s = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

// ДД.ММ.РРРР (або вже РРРР-ММ-ДД) → РРРР-ММ-ДД; порожнє чи сміття → "".
export function sheetDate(v) {
  const s = String(v || "").trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + "-" + m[2] + "-" + m[3] : "";
}

const clean = (v, n = 160) => String(v == null ? "" : v).replace(/[​-‏‪-‮⁠﻿]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const norm = (h) => clean(h).toLowerCase();

export function rowsToPeople(rows) {
  if (!rows.length) throw new Error("Аркуш «" + sheetName() + "» порожній.");
  const head = rows[0].map(norm);
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ix = {
    name: col("піб"), inn: col("іпн"), status: col("статус"), hired: col("дата прийому"), left: col("дата звільнення"),
    position: col("посада"), dept: col("відділ"), division: col("підрозділ"), id: col("id"),
  };
  const missing = Object.entries({ ПІБ: ix.name, Статус: ix.status, id: ix.id }).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) throw new Error("В аркуші «" + sheetName() + "» немає колонок: " + missing.join(", ") + ".");
  const get = (r, i) => (i >= 0 ? r[i] : "");
  const out = [], seen = new Set();
  for (const r of rows.slice(1)) {
    const name = clean(get(r, ix.name));
    const id = clean(get(r, ix.id), 40).replace(/[^\w-]/g, "");
    if (!name || !id || seen.has(id)) continue;
    seen.add(id);
    const gone = norm(get(r, ix.status)).startsWith("звільн");
    const leftOn = sheetDate(get(r, ix.left)) || (gone ? "today" : "");
    out.push({
      sheetId: id, name, email: "", number: "",
      position: clean(get(r, ix.position)), department: clean(get(r, ix.dept)), division: clean(get(r, ix.division)),
      hiredOn: sheetDate(get(r, ix.hired)), leftOn,
      inn: cleanInn(clean(get(r, ix.inn), 40).replace(/[^0-9A-Za-zА-ЯІЇЄҐа-яіїєґ]/g, "")),
    });
  }
  return out;
}

const b64 = (x) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");

async function serviceToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", typ: "JWT" });
  const claim = b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 });
  const sig = crypto.createSign("RSA-SHA256").update(head + "." + claim).sign(String(sa.private_key || "").replace(/\\n/g, "\n"), "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: head + "." + claim + "." + sig }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error("Google не видав токен сервісному акаунту (HTTP " + res.status + "). Перевірте GOOGLE_SERVICE_ACCOUNT_JSON.");
  return data.access_token;
}

function serviceAccount() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
    if (!sa.client_email || !sa.private_key) throw new Error("x");
    return sa;
  } catch (e) { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON має бути ключем сервісного акаунта (JSON або base64)."); }
}

async function pullViaApi(sa) {
  const token = await serviceToken(sa);
  const url = "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(sheetId()) + "/values/" +
    encodeURIComponent(sheetName()) + "?valueRenderOption=FORMATTED_VALUE";
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
  if (res.status === 403 || res.status === 404) throw new Error("Сервісний акаунт " + sa.client_email + " не має доступу до таблиці (HTTP " + res.status + ").");
  if (!res.ok) throw new Error("Sheets API відповів " + res.status + ".");
  const data = await res.json();
  return (data.values || []).map((r) => r.map((v) => String(v == null ? "" : v)));
}

const scriptUrl = () => (process.env.STAFF_SHEET_URL || "").trim();
const scriptKey = () => (process.env.STAFF_SHEET_SECRET || process.env.ZP_SHEET_SECRET || "").trim();

async function pullViaScript() {
  if (scriptKey().length < 16) throw new Error("Не задано STAFF_SHEET_SECRET (від 16 символів) для скрипта таблиці.");
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    res = await fetch(scriptUrl(), { method: "POST", redirect: "follow", signal: ctrl.signal, cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: scriptKey(), action: "staff", sheet: sheetName() }) });
    clearTimeout(timer);
  } catch (e) {
    throw new Error("Скрипт таблиці не відповів: " + (e && e.name === "AbortError" ? "надто довго" : "немає зв'язку") + ".");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error("Скрипт таблиці відповів помилкою (HTTP " + res.status + "). Перевірте адресу й доступ «Будь-хто з посиланням» до веб-застосунку.");
  if (data.error) throw new Error(String(data.error).slice(0, 200));
  return (Array.isArray(data.rows) ? data.rows : []).map((r) => (Array.isArray(r) ? r : []).map((v) => String(v == null ? "" : v)));
}

export async function pullStaffSheet() {
  if (/^https:\/\/script\.google\.com\//.test(scriptUrl())) {
    const people = rowsToPeople(await pullViaScript());
    if (!people.length) throw new Error("В аркуші «" + sheetName() + "» немає жодного співробітника.");
    return people;
  }
  const sa = serviceAccount();
  if (sa) {
    const people = rowsToPeople(await pullViaApi(sa));
    if (!people.length) throw new Error("В аркуші «" + sheetName() + "» немає жодного співробітника.");
    return people;
  }
  const url = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(sheetId()) +
    "/gviz/tq?tqx=out:csv&sheet=" + encodeURIComponent(sheetName());
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    res = await fetch(url, { cache: "no-store", redirect: "follow", signal: ctrl.signal });
    clearTimeout(timer);
  } catch (e) {
    throw new Error("Таблиця співробітників не відповіла: " + (e && e.name === "AbortError" ? "надто довго" : "немає зв'язку") + ".");
  }
  const text = await res.text();
  if (!res.ok || /^\s*<(!doctype|html)/i.test(text)) {
    throw new Error("Не вдалось прочитати таблицю співробітників (HTTP " + res.status + "). Таблиця не публічна: задайте STAFF_SHEET_URL (Apps Script у таблиці) або відкрийте доступ за посиланням.");
  }
  const people = rowsToPeople(parseCsv(text));
  if (!people.length) throw new Error("В аркуші «" + sheetName() + "» немає жодного співробітника.");
  return people;
}

/* Ід у таблиці — власна нумерація, не ід PeopleForce: збігатися за ним з картками PF не можна
   (можна «приклеїти» чужу людину). Тому люди зіставляються за sheetId (його запам'ятовуємо
   в картці) або за ПІБ: два перші слова, порядок байдужий. Неоднозначні збіги пропускаємо. */
export const nameKey = (n) => clean(n).toLowerCase().replace(/[’ʼ`]/g, "'").split(" ").filter(Boolean).slice(0, 2).sort().join(" ");

/* Чиста функція: застосовує список з таблиці до стану. PeopleForce-поля картки (pfId, pfFio,
   pfPosition, pfDivision) не чіпає. Нові люди — без pfId. Повертає також innByEmp: ІПН за ід картки.
   repairAt — позначка часу невдалого імпорту (за ід): лише тоді прибираємо створені ним дублі й
   відновлюємо з PeopleForce (pfPeople) поля, які той імпорт зіпсував. */
export function applySheetPeople(state, people, today, stamp, opts = {}) {
  const { repairAt = "", pfPeople = null } = opts;
  const tomb = { ...(state.deleted || {}) };
  let employees = (state.employees || []).map((e) => ({ ...e }));
  const report = { added: [], updated: [], left: [], returned: [], changes: [], baseline: 0, skipped: 0, removed: [], restored: [], ambiguous: [] };

  if (repairAt) {
    const blob = JSON.stringify([state.transfers, state.entries, state.fin, state.fpv, state.teams]);
    const live = () => employees.filter((e) => !tomb["e:" + e.id]);
    const fresh = (e) => e.updatedAt === repairAt && e.source === "peopleforce" && /^e_pf/.test(e.id) && !e.base && !e.teamId && !(e.teamHist || []).length && !blob.includes(e.id);
    for (const x of live().filter(fresh)) {
      const twin = live().find((o) => o.id !== x.id && !fresh(o) && nameKey(o.name) === nameKey(x.name));
      if (!twin) continue;
      tomb["e:" + x.id] = stamp;
      report.removed.push(x.name);
    }
    employees = employees.filter((e) => !tomb["e:" + e.id]);
    // Картки, яких той імпорт торкнувся (не нові): повертаємо поля PeopleForce з самого PF.
    const pf = new Map((pfPeople || []).map((p) => [String(p.pfId), p]));
    employees = employees.map((e) => {
      if (e.updatedAt !== repairAt || fresh(e) || !e.pfId) return e;
      const p = pf.get(String(e.pfId));
      if (!p || nameKey(p.name) !== nameKey(e.name)) {
        const { pfFio, pfPosition, pfDivision, ...rest } = e;
        report.restored.push(e.name + " (поля PF скинуто — перевірте ід PeopleForce)");
        return { ...rest, updatedAt: stamp };
      }
      report.restored.push(e.name);
      return { ...e, pfFio: p.pfFio || "", pfPosition: p.position || "", pfDivision: p.division || "",
        leftOn: p.leftOn === "today" ? today : (p.leftOn || ""), updatedAt: stamp };
    });
  }

  const live = employees.filter((e) => !tomb["e:" + e.id]);
  const taken = new Set();
  const innByEmp = {};
  const byKey = new Map();
  live.forEach((e) => { const k = nameKey(e.name); byKey.set(k, [...(byKey.get(k) || []), e]); });
  const find = (p) => {
    const bySheet = live.find((e) => e.sheetId && e.sheetId === p.sheetId && !taken.has(e.id));
    if (bySheet) return bySheet;
    const c = (byKey.get(nameKey(p.name)) || []).filter((e) => !taken.has(e.id) && !(e.sheetId && e.sheetId !== p.sheetId));
    if (c.length > 1) { report.ambiguous.push(p.name); return "skip"; }
    return c[0] || null;
  };

  const order = [...people].sort((a, b) => (a.leftOn ? 1 : 0) - (b.leftOn ? 1 : 0));
  for (const p of order) {
    const leftOn = p.leftOn === "today" ? today : p.leftOn;
    const e = find(p);
    if (e === "skip") { report.skipped++; continue; }
    if (!e) {
      if (leftOn && leftOn < today) { report.skipped++; continue; } // давно звільнених не додаємо
      const id = "e_sh" + p.sheetId;
      if (tomb["e:" + id]) { report.skipped++; continue; } // адміністратор прибрав цю людину — не повертаємо
      const emp = { id, name: p.name, email: "", position: p.position, department: p.department, division: p.division,
        hiredOn: p.hiredOn, leftOn: leftOn || "", pfId: "", sheetId: p.sheetId, extId: "", base: "", source: "sheet", updatedAt: stamp };
      employees.push(emp); taken.add(id);
      if (p.inn) innByEmp[id] = p.inn;
      report.added.push(p.name);
      continue;
    }
    taken.add(e.id);
    if (p.inn) innByEmp[e.id] = p.inn;
    // Наявних людей не чіпаємо: лише ід таблиці й статус «працює / звільнений».
    if (e.sheetId === p.sheetId && String(e.leftOn || "") === String(leftOn || "")) continue;
    const i = employees.findIndex((x) => x.id === e.id);
    employees[i] = { ...e, sheetId: p.sheetId, leftOn: leftOn || "", updatedAt: stamp };
    if (leftOn && !e.leftOn) report.left.push(p.name + " — " + leftOn);
    else if (!leftOn && e.leftOn) report.returned.push(p.name);
    else if ((leftOn || "") !== (e.leftOn || "")) report.updated.push(p.name + " (звільнення: " + (e.leftOn || "—") + " → " + (leftOn || "—") + ")");
  }
  return { state: { ...state, employees, deleted: tomb }, report, innByEmp };
}
