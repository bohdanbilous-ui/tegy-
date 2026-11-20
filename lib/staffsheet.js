// Google Таблиця «Fincore ERP Staff» → довідник людей. Лише читання.
// Аркуш «Співробітники»: ПІБ, ІПН, Статус, Дата прийому, Дата звільнення, Посада, Відділ,
// Підрозділ, Категорія (id), Категорія, У PeopleForce, id.
// Таблиця має бути доступна за посиланням («Будь-хто з посиланням — перегляд»).
// Результат — той самий формат, що й у normalize() з peopleforce.js, тож далі працює applyPeople.
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

export async function pullStaffSheet() {
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
    throw new Error("Не вдалось прочитати таблицю співробітників (HTTP " + res.status + "). Відкрийте доступ «Будь-хто з посиланням — перегляд» або задайте STAFF_SHEET_ID.");
  }
  const people = rowsToPeople(parseCsv(text));
  if (!people.length) throw new Error("В аркуші «" + sheetName() + "» немає жодного співробітника.");
  return people;
}
