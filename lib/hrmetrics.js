// HR-метрики за списком співробітників. Чисті функції без залежностей — працюють у браузері й у тестах.
// Дані: hiredOn / leftOn (з PeopleForce або з картки). Без hiredOn людина вважається «давно в компанії»
// і рахується у штаті, але не потрапляє у найми й стаж (лічильник noHire показує, скільки таких).

const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const parse = (s) => new Date(s + "T00:00:00");
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const monthEnd = (y, m) => iso(new Date(y, m, 0)); // m: 1..12
const ymKey = (y, m) => y + "-" + String(m).padStart(2, "0");

// Працює в компанії на дату date (включно з останнім робочим днем).
export const onStaff = (e, date) => (!e.hiredOn || e.hiredOn <= date) && (!e.leftOn || e.leftOn >= date);
export const headcountOn = (employees, date) => employees.filter((e) => onStaff(e, date)).length;

// Останні n календарних місяців (включно з поточним): найми, звільнення, штат на кінець, плинність.
export function monthlySeries(employees, today, n = 12) {
  const t = parse(today);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(t.getFullYear(), t.getMonth() - i, 1);
    const y = d.getFullYear(), m = d.getMonth() + 1, key = ymKey(y, m);
    const start = iso(d), end = monthEnd(y, m) > today ? today : monthEnd(y, m);
    const hires = employees.filter((e) => e.hiredOn && e.hiredOn.slice(0, 7) === key).length;
    const leavers = employees.filter((e) => e.leftOn && e.leftOn !== "today" && e.leftOn.slice(0, 7) === key && e.leftOn <= today).length;
    const hcStart = headcountOn(employees, addDays(start, -1)), hcEnd = headcountOn(employees, end);
    const avg = (hcStart + hcEnd) / 2;
    out.push({ key, y, m, hires, leavers, headcount: hcEnd, net: hires - leavers, turnover: avg ? leavers / avg : 0 });
  }
  return out;
}

// Плинність за останні 12 місяців: звільнені / середній штат.
export function turnover12(employees, today) {
  const from = addDays(today, -365);
  const leavers = employees.filter((e) => e.leftOn && e.leftOn > from && e.leftOn <= today);
  const avg = (headcountOn(employees, from) + headcountOn(employees, today)) / 2;
  const early = leavers.filter((e) => e.hiredOn && daysBetween(e.hiredOn, e.leftOn) <= 90);
  return { leavers: leavers.length, avgHeadcount: avg, rate: avg ? leavers.length / avg : 0, early: early.length };
}

export const TENURE_BUCKETS = [["до 3 міс", 0, 92], ["3–6 міс", 92, 183], ["6–12 міс", 183, 365], ["1–2 роки", 365, 730], ["2+ років", 730, Infinity]];

// Стаж поточних працівників.
export function tenure(employees, today) {
  const cur = employees.filter((e) => onStaff(e, today));
  const known = cur.filter((e) => e.hiredOn && e.hiredOn <= today);
  const days = known.map((e) => daysBetween(e.hiredOn, today));
  const buckets = TENURE_BUCKETS.map(([label, a, b]) => ({ label, count: days.filter((d) => d >= a && d < b).length }));
  const avgMonths = days.length ? days.reduce((s, d) => s + d, 0) / days.length / 30.44 : 0;
  const sorted = days.slice().sort((a, b) => a - b);
  const medianMonths = sorted.length ? sorted[Math.floor(sorted.length / 2)] / 30.44 : 0;
  return { buckets, avgMonths, medianMonths, known: known.length, noHire: cur.length - known.length, total: cur.length };
}

// Розріз по групі (команда, БЮ, посада…): штат, найми та звільнення за 12 міс., плинність.
export function byGroup(employees, today, keyOf) {
  const from = addDays(today, -365);
  const map = new Map();
  employees.forEach((e) => {
    const k = keyOf(e) || "—";
    const g = map.get(k) || { name: k, headcount: 0, hires: 0, leavers: 0, startHc: 0 };
    if (onStaff(e, today)) g.headcount++;
    if (onStaff(e, from)) g.startHc++;
    if (e.hiredOn && e.hiredOn > from && e.hiredOn <= today) g.hires++;
    if (e.leftOn && e.leftOn > from && e.leftOn <= today) g.leavers++;
    map.set(k, g);
  });
  return [...map.values()]
    .map((g) => ({ ...g, turnover: (g.headcount + g.startHc) ? g.leavers / ((g.headcount + g.startHc) / 2) : 0 }))
    .filter((g) => g.headcount || g.leavers || g.hires)
    .sort((a, b) => b.headcount - a.headcount || a.name.localeCompare(b.name, "uk"));
}

// Найближчі події: нові люди й ті, хто йде (або вже оголошений вихід).
export function upcoming(employees, today, windowDays = 60) {
  const horizon = addDays(today, windowDays), back = addDays(today, -30);
  const joined = employees.filter((e) => e.hiredOn && e.hiredOn >= back && e.hiredOn <= horizon && (!e.leftOn || e.leftOn >= e.hiredOn))
    .sort((a, b) => a.hiredOn.localeCompare(b.hiredOn));
  const leaving = employees.filter((e) => e.leftOn && e.leftOn !== "today" && e.leftOn > today && e.leftOn <= horizon)
    .sort((a, b) => a.leftOn.localeCompare(b.leftOn));
  return { joined, leaving };
}
