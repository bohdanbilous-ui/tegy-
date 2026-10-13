// Факт по переведеннях: фактично відпрацьовані години за половину місяця.
//
// Потік:
//   1. Створюється переведення (план). Для ТИМЧАСОВИХ і ЧАСТКОВИХ воно потребує факту.
//   2. Коли половина місяця минула, PM проєкту, який приймає людину, вносить, скільки годин
//      вона фактично відпрацювала (або «як заплановано»).
//   3. PM проєкту, звідки людина (хто віддає), підтверджує. Може будь-хто з PM проєкту.
//   4. На теги впливають ЛИШЕ підтверджені години; до того тег іде за планом (переведенням).
//
// Частка проєкту, що приймає = його години ÷ усі години людини за період:
// з табеля, якщо людину ведуть у годинах, інакше — норма (будні × 8).
// Решта (100% − частки фактів) ділиться пропорційно звичайному розподілу людини;
// якщо в ньому більше нікого немає (людину переведено повністю на проєкт, що приймає) —
// пропорційно тому, як людина була розподілена до переведення (`rest` у записі).
// Спільне для браузера й сервера.

import { asAlloc, allocMap } from "./alloc";

export const LOANS_KEY = "transfers:loans:v1";
export const PERIOD_RE = /^\d{4}-\d{2}-H[12]$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const LOAN_STATUS = ["pending", "confirmed", "rejected"];
export const MAX_LOAN_HOURS = 744;

const pad = (n) => String(n).padStart(2, "0");
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

export function periodRange(key) {
  const y = +key.slice(0, 4), m = +key.slice(5, 7), mk = key.slice(0, 7);
  return key.endsWith("H1") ? { from: mk + "-01", to: mk + "-15" } : { from: mk + "-16", to: mk + "-" + pad(lastDay(y, m)) };
}

export const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const keyOfDate = (iso) => iso.slice(0, 7) + (+iso.slice(8, 10) <= 15 ? "-H1" : "-H2");
export const prevKey = (key) => {
  if (key.endsWith("H2")) return key.slice(0, 7) + "-H1";
  const y = +key.slice(0, 4), m = +key.slice(5, 7);
  return (m === 1 ? y - 1 + "-12" : y + "-" + pad(m - 1)) + "-H2";
};

// Робочі дні (пн–пт) між двома датами включно. Свят не враховуємо.
function weekdays(from, to) {
  let n = 0;
  for (const d = new Date(from + "T00:00:00Z"), end = new Date(to + "T00:00:00Z"); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

// Норма годин періоду: робочі дні × 8.
export function normHours(key) {
  const { from, to } = periodRange(key);
  return weekdays(from, to) * 8;
}

function roundAlloc(raw) {
  const rows = [...raw].map(([project, v]) => ({ project, percent: Math.floor(v + 1e-9), rest: v - Math.floor(v + 1e-9) }));
  let left = Math.round([...raw.values()].reduce((s, v) => s + v, 0)) - rows.reduce((s, r) => s + r.percent, 0);
  rows.slice().sort((a, b) => b.rest - a.rest).forEach((r) => { if (left > 0) { r.percent++; left--; } });
  return rows.filter((r) => r.percent > 0).map(({ project, percent }) => ({ project, percent }));
}

/* ── які переведення потребують факту ── */

// Тимчасове або часткове (після нього людина на двох і більше проєктах).
export const factNeeded = (t) => !!t && !t.cancelled && !!t.employeeId && DATE_RE.test(t.effectiveDate || "")
  && (!!t.temporary || asAlloc(t.to).filter((r) => r.percent > 0).length > 1);

// Останній день дії переведення (включно): для тимчасового — день перед поверненням; безстрокове — null.
export const transferEnd = (t) => (t.temporary && DATE_RE.test(t.returnDate || "") ? addDays(t.returnDate, -1) : null);

// Робочі години періоду, що припадають на дії переведення.
export function overlapHours(key, start, end) {
  const r = periodRange(key);
  const a = start > r.from ? start : r.from;
  const b = end && end < r.to ? end : r.to;
  return a > b ? 0 : weekdays(a, b) * 8;
}

// Проєкти, що приймають (їх частка зросла) і віддають (зменшилась) у переведенні.
export function sides(t) {
  const f = allocMap(t.from), g = allocMap(t.to);
  const all = [...new Set([...Object.keys(f), ...Object.keys(g)])];
  return {
    takes: all.filter((p) => (g[p] || 0) - (f[p] || 0) > 0.01),
    gives: all.filter((p) => (g[p] || 0) - (f[p] || 0) < -0.01),
    to: g,
  };
}

/* Місця, де потрібен факт: по кожному проєкту, що приймає, і кожній ЗАВЕРШЕНІЙ половині місяця,
   у якій переведення діяло. today — "YYYY-MM-DD" (за Києвом). maxPeriods — обмеження вглиб. */
export function factSlots(t, today, maxPeriods = 36) {
  if (!factNeeded(t)) return [];
  const { takes, gives, to } = sides(t);
  if (!takes.length) return [];
  const end = transferEnd(t);
  const yesterday = addDays(today, -1);
  const lastDayIn = end && end < yesterday ? end : yesterday;
  if (lastDayIn < t.effectiveDate) return [];
  let key = keyOfDate(lastDayIn);
  if (periodRange(key).to >= today) key = prevKey(key); // півмісяця ще триває
  const from = asAlloc(t.from);
  const out = [];
  for (let i = 0; i < maxPeriods; i++) {
    const r = periodRange(key);
    if (r.to < t.effectiveDate) break;
    const hrs = overlapHours(key, t.effectiveDate, end);
    if (hrs > 0) {
      takes.forEach((p) => {
        const rows = from.filter((x) => x.project !== p && x.percent > 0);
        const sum = rows.reduce((s, x) => s + x.percent, 0);
        out.push({
          transferId: t.id, employeeId: t.employeeId, employeeName: t.employeeName || "", project: p, lenders: gives.slice(),
          rest: sum > 0 ? rows.map((x) => ({ project: x.project, percent: r2((x.percent * 100) / sum) })) : [],
          periodKey: key, pct: r2(to[p] || 0), planHours: r1((hrs * (to[p] || 0)) / 100),
        });
      });
    }
    key = prevKey(key);
  }
  return out;
}

// Проєкти, звідки людину взято (хто підтверджує факт).
export const lendersOf = (l) => (Array.isArray(l.lenderProjects) && l.lenderProjects.length ? l.lenderProjects : l.lenderProject ? [l.lenderProject] : []);

/* ── вплив підтверджених годин на розподіл ── */

/* Частки проєктів, що приймають, у відсотках: { project: % }. Сума не більша за 100. */
export function loanShares(loans, totalHours) {
  const total = Number(totalHours) || 0;
  const out = new Map();
  if (total <= 0) return out;
  (loans || []).forEach((l) => {
    const h = Number(l.hours) || 0;
    if (h > 0 && l.project) out.set(l.project, (out.get(l.project) || 0) + (h * 100) / total);
  });
  const s = [...out.values()].reduce((a, v) => a + v, 0);
  if (s > 100) out.forEach((v, k) => out.set(k, (v * 100) / s));
  return out;
}

/* Розподіл половини місяця з урахуванням підтверджених фактів.
   alloc — звичайний розподіл (табель / переведення), loans — підтверджені записи цього періоду.
   Повертає { alloc, applied } — applied=false, якщо застосовувати нічого. */
export function applyLoans(alloc, loans, totalHours) {
  const base = (alloc || []).map((r) => ({ project: r.project, percent: Number(r.percent) || 0 })).filter((r) => r.percent > 0);
  const shares = loanShares(loans, totalHours);
  if (!shares.size || !base.length) return { alloc: base, applied: false };
  const S = [...shares.values()].reduce((a, v) => a + v, 0);
  let pool = base.filter((r) => !shares.has(r.project));
  let baseSum = pool.reduce((a, r) => a + r.percent, 0);
  if (baseSum <= 0) {
    // Людина за планом повністю на проєктах, що приймають: залишок повертаємо тим, звідки її взяли.
    const back = new Map();
    (loans || []).forEach((l) => (l.rest || []).forEach((r) => {
      if (!shares.has(r.project) && r.percent > 0) back.set(r.project, (back.get(r.project) || 0) + r.percent);
    }));
    pool = [...back].map(([project, percent]) => ({ project, percent }));
    baseSum = pool.reduce((a, r) => a + r.percent, 0);
    if (baseSum <= 0) return { alloc: base, applied: false };
  }
  const raw = new Map();
  const rest = Math.max(0, 100 - S);
  pool.forEach((r) => raw.set(r.project, (raw.get(r.project) || 0) + (r.percent * rest) / baseSum));
  shares.forEach((v, p) => raw.set(p, (raw.get(p) || 0) + v));
  return { alloc: roundAlloc(raw), applied: true };
}

export const loanText = (loans) => (loans || []).map((l) => l.project + " " + l.hours + " год").join(" + ");

// Індекс підтверджених записів з годинами: "empId|periodKey" → [loan].
// Запис «як заплановано» (без годин) нічого не змінює, тому в індекс не потрапляє.
export function confirmedIndex(loans) {
  const m = new Map();
  (loans || []).filter((l) => l.status === "confirmed" && Number(l.hours) > 0).forEach((l) => {
    const k = l.employeeId + "|" + l.periodKey;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(l);
  });
  return m;
}
