// Звірка PM: план за Allocate проти фактичних годин з трекерів (Redmine, ClickUp — через дашборд).
//
// Потік:
//   1. Адміністратор завантажує години за половину місяця (людина; проєкт; години) — тестове джерело,
//      потім його замінить дашборд.
//   2. PM бачить по своїх проєктах: план (% за розподілом, зважений за робочими днями), факт (години ÷ норма).
//      Відхилення понад допуск — «червоний» рядок: PM обирає дію й пише коментар.
//   3. Коли всі червоні рядки мають рішення, PM підтверджує звірку. Підтвердження — за проєктом
//      (будь-кого з PM проєкту), зі знімком цифр: якщо дані потім змінились, воно «застаріле».
//   4. Бухгалтер у відомості ЗП бачить, які проєкти підтверджені.
// Чисті функції: працюють на сервері й у тестах.

import { allocAt } from "./alloc";
import { periodRange, normHours } from "./loans";

export const HOURS_KEY = "transfers:recon:hours:v1"; // { [period]: { at, by, rows: [{ person, project, hours }] } }
export const CONF_KEY = "transfers:recon:confirm:v1"; // { [period]: { res: { "empId|project": {...} }, ok: { [project]: {...} } } }
export const CFG_KEY = "transfers:recon:cfg:v1"; // { tol, tolSmall, smallUpTo }
export const DEFAULT_CFG = { tol: 10, tolSmall: 5, smallUpTo: 20 };
export const ACTIONS = { plan: "План застарів", tracker: "Трекер заповнено неточно", manual: "Мої години" };

const low = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const r1 = (v) => Math.round(v * 10) / 10;
export const rowKey = (empId, project) => empId + "|" + project;

export const cleanCfg = (c) => {
  const n = (v, d, max) => { if (v == null || v === "") return d; const x = Number(v); return Number.isFinite(x) && x >= 0 && x <= max ? x : d; };
  return { tol: n(c && c.tol, DEFAULT_CFG.tol, 100), tolSmall: n(c && c.tolSmall, DEFAULT_CFG.tolSmall, 100), smallUpTo: n(c && c.smallUpTo, DEFAULT_CFG.smallUpTo, 100) };
};

function workdays(from, to) {
  const out = [];
  for (const d = new Date(from + "T00:00:00Z"), end = new Date(to + "T00:00:00Z"); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// План людини за період: середній за робочими днями відсоток по проєктах (з урахуванням переведень).
export function planOf(emp, transfers, key) {
  const { from, to } = periodRange(key);
  const days = workdays(from, to).filter((d) => (!emp.hiredOn || emp.hiredOn <= d) && (!emp.leftOn || emp.leftOn >= d));
  const out = {};
  if (!days.length) return out;
  const all = workdays(from, to).length;
  days.forEach((d) => allocAt(emp, transfers, d).forEach((x) => { if (x.percent > 0) out[x.project] = (out[x.project] || 0) + x.percent; }));
  Object.keys(out).forEach((p) => { out[p] = r1(out[p] / all); }); // ділимо на всі робочі дні періоду: неповний період дає менший план
  return out;
}

export const tolFor = (planPct, cfg) => (planPct <= cfg.smallUpTo ? cfg.tolSmall : cfg.tol);

/* Рядки звірки. projects — множина проєктів, які бачить користувач.
   hours — { rows: [{ person, project, hours }] } або null (годин немає).
   res — рішення PM: { "empId|project": { action, comment, hours } }. */
export function reconRows({ key, employees, transfers, projects, hours, res, cfg }) {
  const norm = normHours(key);
  const byPerson = new Map();
  ((hours && hours.rows) || []).forEach((h) => {
    const k = low(h.person);
    if (!byPerson.has(k)) byPerson.set(k, {});
    const m = byPerson.get(k);
    m[h.project] = (m[h.project] || 0) + (Number(h.hours) || 0);
  });
  const rows = [];
  (employees || []).forEach((e) => {
    const plan = planOf(e, transfers, key);
    const fact = byPerson.get(low(e.name)) || null;
    const names = new Set([...Object.keys(plan), ...(fact ? Object.keys(fact) : [])]);
    names.forEach((project) => {
      if (!projects.has(project)) return;
      const planPct = plan[project] || 0;
      const trackerHours = fact ? r1(fact[project] || 0) : null;
      const r = (res || {})[rowKey(e.id, project)] || null;
      const manual = r && r.action === "manual" && Number.isFinite(Number(r.hours)) ? Number(r.hours) : null;
      const factHours = manual != null ? manual : trackerHours;
      const noData = factHours == null;
      const factPct = noData ? null : r1((factHours / norm) * 100);
      const diff = noData ? null : r1(factPct - planPct);
      const tol = tolFor(planPct, cfg);
      let state = "ok";
      if (noData) state = hours ? "nodata" : "nosource"; // є завантажені години, але людини в них немає / годин узагалі немає
      else if (Math.abs(diff) > tol) state = "warn";
      rows.push({ employeeId: e.id, name: e.name, project, planPct, trackerHours, factHours, factPct, diff, tol, state, res: r, norm });
    });
  });
  rows.sort((a, b) => a.project.localeCompare(b.project, "uk") || a.name.localeCompare(b.name, "uk"));
  return rows;
}

// Рядок потребує рішення PM, поки є відхилення чи немає даних, а рішення не обране.
export const needsDecision = (r) => (r.state === "warn" || r.state === "nodata") && !r.res;

// Відбиток цифр проєкту: після підтвердження будь-яка зміна плану чи факту робить підтвердження застарілим.
export function fingerprint(rows) {
  const str = rows.map((r) => [r.employeeId, r.project, r.planPct, r.factHours, r.res ? r.res.action : ""].join("|")).sort().join("\n");
  let h = 5381; for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return String(h);
}

// Розбір тексту «людина; проєкт; години» (роздільник ; , або табуляція).
export function parseHoursText(text) {
  const rows = [], bad = [];
  String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
    if (/^(людина|person|співробітник|піб)[\s;,\t]/i.test(line)) return; // заголовок
    const parts = line.split(/[;\t]|,(?=[^,]*,[^,]*$)/).map((s) => s.trim());
    if (parts.length < 3) { bad.push(i + 1); return; }
    const hours = Number(String(parts[parts.length - 1]).replace(",", "."));
    const person = parts[0], project = parts.slice(1, -1).join(" ").trim();
    if (!person || !project || !Number.isFinite(hours) || hours < 0 || hours > 744) { bad.push(i + 1); return; }
    rows.push({ person, project, hours });
  });
  return { rows, bad };
}
