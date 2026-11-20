// Google Таблиця «Fincore ERP Staff» → довідник людей. Лише читання.
// Аркуш «Співробітники»: ПІБ, ІПН, Статус, Дата прийому, Дата звільнення, Посада, Відділ,
// Підрозділ, Категорія (id), Категорія, У PeopleForce, id.
// Доступ: змінна GOOGLE_SERVICE_ACCOUNT_JSON (ключ сервісного акаунта, якому дано доступ до таблиці) —
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
      pfId: id, name, email: "", number: "",
      position: clean(get(r, ix.position)), department: clean(get(r, ix.dept)), division: clean(get(r, ix.division)),
      hiredOn: sheetDate(get(r, ix.hired)), leftOn, pfFio: name,
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

export async function pullStaffSheet() {
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
    throw new Error("Не вдалось прочитати таблицю співробітників (HTTP " + res.status + "). Таблиця не публічна: задайте GOOGLE_SERVICE_ACCOUNT_JSON (сервісний акаунт з доступом до таблиці) або відкрийте доступ за посиланням.");
  }
  const people = rowsToPeople(parseCsv(text));
  if (!people.length) throw new Error("В аркуші «" + sheetName() + "» немає жодного співробітника.");
  return people;
}
