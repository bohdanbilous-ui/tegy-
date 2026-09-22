// Нагадування відповідальним про табель. Лише сервер.
// Надсилає їх заплановане завдання в Slack від імені адміністратора: воно забирає готові
// тексти з /api/reminders (з ключем REMINDER_SECRET) і повідомляє, що надіслало.
import { sameName } from "./users";
import { workingOn } from "./people";

export const KEY = "transfers:reminders:v1";
const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const pad = (n) => String(n).padStart(2, "0");
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export const DEFAULT_TEMPLATE = [
  "Привіт, {ім'я}! 👋 Нагадування: час внести відсотки залученості команди «{команда}» за період «{період}».",
  "",
  "Зараз заповнено {заповнено}.{бракує}",
  "",
  "1. Зайдіть на {посилання} під своїм логіном",
  "2. Заповніть таблицю — у кожному рядку має бути 100%",
  "3. Натисніть «Подати період»",
  "",
  "Питання — пишіть Богдану Білоусу.",
].join("\n");

// Slack ID, які вже використовувало нагадування. Адміністратор може змінити їх у застосунку.
export const DEFAULT_SLACK = {
  "Тарас Мамай": "U09SL292DTQ", "Станіслав Стояцький": "U09T91QMH4G", "Христина Чепурна": "U0A9N66RDQC",
  "Тарас Грищук": "U09Q7HEHRNK", "Галина Никончук": "U0BNYDQAQ9H", "Євгеній Кулик": "U09RZA7H00P",
};

export const kyivNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: p.year + "-" + p.month + "-" + p.day, hour: Number(p.hour) };
};
export const periodOfDate = (d) => d.slice(0, 7) + "-H" + (Number(d.slice(8, 10)) <= 15 ? 1 : 2);
export const periodStart = (k) => k.slice(0, 7) + "-" + (k.endsWith("H1") ? "01" : "16");
export function periodLabel(k) {
  const y = Number(k.slice(0, 4)), m = Number(k.slice(5, 7));
  return MONTHS[m - 1] + " " + y + ", " + (k.endsWith("H1") ? "01–15" : "16–" + lastDay(y, m));
}
export function shiftPeriod(k, n) {
  let idx = Number(k.slice(0, 4)) * 24 + (Number(k.slice(5, 7)) - 1) * 2 + (k.endsWith("H1") ? 0 : 1) + n;
  const y = Math.floor(idx / 24); idx -= y * 24;
  return y + "-" + pad(Math.floor(idx / 2) + 1) + "-H" + ((idx % 2) + 1);
}
// Дні автонагадування: 14-те і передостанній день місяця — для періоду, що закінчується.
export function autoPeriodFor(date) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
  if (d === 14) return date.slice(0, 7) + "-H1";
  if (d === lastDay(y, m) - 1) return date.slice(0, 7) + "-H2";
  return "";
}

export const normalize = (cfg) => ({
  template: typeof cfg?.template === "string" && cfg.template.trim() ? cfg.template : DEFAULT_TEMPLATE,
  slack: { ...DEFAULT_SLACK, ...(cfg?.slack || {}) },
  auto: cfg?.auto !== false,
  jobs: Array.isArray(cfg?.jobs) ? cfg.jobs : [],
  autoSent: cfg?.autoSent || {},
  updatedAt: cfg?.updatedAt || "", updatedBy: cfg?.updatedBy || "",
});

const firstName = (full) => String(full || "").trim().split(/\s+/)[0] || "";

/* Стан періоду по командах: хто відповідає, скільки заповнено, чи подано. */
export function periodStatus(state, key) {
  const tomb = state.deleted || {};
  const start = periodStart(key);
  const entries = new Map((state.entries || []).filter((x) => x.periodKey === key).map((x) => [x.employeeId, x]));
  return (state.teams || []).filter((t) => !tomb["tm:" + t.id]).map((t) => {
    const people = (state.employees || []).filter((e) => e.teamId === t.id && !tomb["e:" + e.id] && workingOn(e, start));
    const total = (e) => ((entries.get(e.id) || {}).alloc || []).reduce((s, r) => s + (Number(r.percent) || 0), 0);
    const missing = people.filter((e) => Math.abs(total(e) - 100) > 0.01).map((e) => e.name);
    const sb = (t.submitted || {})[key];
    return { teamId: t.id, team: t.name, owner: t.owner || "", people: people.length, filled: people.length - missing.length, missing, submitted: sb ? { by: sb.by, at: sb.at } : null };
  });
}

export function render(template, row, key, url) {
  const vars = {
    "ім'я": firstName(row.owner), "імʼя": firstName(row.owner), "команда": row.team, "період": periodLabel(key),
    "заповнено": row.filled + " з " + row.people,
    "бракує": row.missing.length ? " Бракує: " + row.missing.slice(0, 15).join(", ") + (row.missing.length > 15 ? " та ще " + (row.missing.length - 15) : "") + "." : "",
    "посилання": url,
  };
  return String(template).replace(/\{([^{}]+)\}/g, (m, k) => (k in vars ? vars[k] : m)).slice(0, 3500);
}

/* Хто отримає: відповідальні команд, що ще не подали період. Одне повідомлення на людину —
   якщо в неї кілька команд, беремо кожну окремим абзацом. */
export function buildTargets(cfg, state, key, url, only) {
  const rows = periodStatus(state, key).filter((r) => r.owner && !r.submitted && r.people > 0);
  const byOwner = new Map();
  rows.forEach((r) => {
    const k = r.owner.trim().toLowerCase();
    if (!byOwner.has(k)) byOwner.set(k, { name: r.owner, rows: [] });
    byOwner.get(k).rows.push(r);
  });
  const slackOf = (name) => Object.entries(cfg.slack).find(([n]) => sameName(n, name))?.[1] || "";
  return [...byOwner.values()]
    .filter((o) => !only || only.some((n) => sameName(n, o.name)))
    .map((o) => ({ name: o.name, slackId: slackOf(o.name), teams: o.rows.map((r) => r.team), text: o.rows.map((r) => render(cfg.template, r, key, url)).join("\n\n———\n\n") }));
}
