// Позичання людей між проєктами: фактично відпрацьовані години за половину місяця.
// PM проєкту, який позичив людину, вносить години; PM проєкту, звідки людина (власник),
// підтверджує. На теги впливають ЛИШЕ підтверджені записи.
// Частка проєкту-позичальника = його години ÷ усі години людини за період:
// з табеля, якщо людину ведуть у годинах, інакше — норма (будні × 8).
// Решта (100% − частки позичань) ділиться пропорційно звичайному розподілу людини.
// Спільне для браузера й сервера.

export const LOANS_KEY = "transfers:loans:v1";
export const PERIOD_RE = /^\d{4}-\d{2}-H[12]$/;
export const LOAN_STATUS = ["pending", "confirmed", "rejected"];
export const MAX_LOAN_HOURS = 744;

const pad = (n) => String(n).padStart(2, "0");
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function periodRange(key) {
  const y = +key.slice(0, 4), m = +key.slice(5, 7), mk = key.slice(0, 7);
  return key.endsWith("H1") ? { from: mk + "-01", to: mk + "-15" } : { from: mk + "-16", to: mk + "-" + pad(lastDay(y, m)) };
}

// Норма годин періоду: робочі дні (пн–пт) × 8. Свят не враховуємо.
export function normHours(key) {
  const { from, to } = periodRange(key);
  let n = 0;
  for (const d = new Date(from + "T00:00:00Z"), end = new Date(to + "T00:00:00Z"); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n * 8;
}

function roundAlloc(raw) {
  const rows = [...raw].map(([project, v]) => ({ project, percent: Math.floor(v + 1e-9), rest: v - Math.floor(v + 1e-9) }));
  let left = Math.round([...raw.values()].reduce((s, v) => s + v, 0)) - rows.reduce((s, r) => s + r.percent, 0);
  rows.slice().sort((a, b) => b.rest - a.rest).forEach((r) => { if (left > 0) { r.percent++; left--; } });
  return rows.filter((r) => r.percent > 0).map(({ project, percent }) => ({ project, percent }));
}

/* Частки проєктів-позичальників у відсотках: { project: % }. Сума не більша за 100. */
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

/* Розподіл половини місяця з урахуванням підтверджених позичань.
   alloc — звичайний розподіл (табель / переведення), loans — підтверджені записи цього періоду.
   Повертає { alloc, applied } — applied=false, якщо застосовувати нічого. */
export function applyLoans(alloc, loans, totalHours) {
  const base = (alloc || []).map((r) => ({ project: r.project, percent: Number(r.percent) || 0 })).filter((r) => r.percent > 0);
  const shares = loanShares(loans, totalHours);
  if (!shares.size || !base.length) return { alloc: base, applied: false };
  const S = [...shares.values()].reduce((a, v) => a + v, 0);
  const others = base.filter((r) => !shares.has(r.project));
  const baseSum = others.reduce((a, r) => a + r.percent, 0);
  // Людина й так повністю на проєктах-позичальниках — змінювати нічого.
  if (baseSum <= 0) return { alloc: base, applied: false };
  const raw = new Map();
  const rest = Math.max(0, 100 - S);
  others.forEach((r) => raw.set(r.project, (raw.get(r.project) || 0) + (r.percent * rest) / baseSum));
  shares.forEach((v, p) => raw.set(p, (raw.get(p) || 0) + v));
  return { alloc: roundAlloc(raw), applied: true };
}

export const loanText = (loans) => (loans || []).map((l) => l.project + " " + l.hours + " год").join(" + ");

// Індекс підтверджених записів: "empId|periodKey" → [loan].
export function confirmedIndex(loans) {
  const m = new Map();
  (loans || []).filter((l) => l.status === "confirmed").forEach((l) => {
    const k = l.employeeId + "|" + l.periodKey;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(l);
  });
  return m;
}
