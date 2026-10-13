// Розподіл людини за довідником і переведеннями, погодження PM і теги.
// Спільне для сервера (PM, PeopleForce) — у браузері TransferDesk має власні копії цих функцій.

export const asAlloc = (v) => (typeof v === "string" ? [{ project: v, percent: 100 }] : (v || []).map((x) => ({ project: x.project, percent: Number(x.percent) || 0 })));
export const allocMap = (a) => { const m = {}; asAlloc(a).forEach((x) => (m[x.project] = (m[x.project] || 0) + x.percent)); return m; };
export const allocText = (a) => (!a || !a.length ? "—" : asAlloc(a).map((x) => (x.percent === 100 ? x.project : x.project + " " + Number(x.percent.toFixed(2)) + "%")).join(" + "));
export const sameAlloc = (a, b) => {
  const ma = allocMap(a), mb = allocMap(b);
  return [...new Set([...Object.keys(ma), ...Object.keys(mb)])].every((k) => Math.abs((ma[k] || 0) - (mb[k] || 0)) < 0.01);
};

export function allocAt(emp, transfers, dateISO) {
  let a = asAlloc(emp.base);
  (transfers || [])
    .filter((t) => t.employeeId === emp.id && !t.cancelled && t.effectiveDate <= dateISO)
    .sort((x, y) => x.effectiveDate.localeCompare(y.effectiveDate) || String(x.createdAt || "").localeCompare(String(y.createdAt || "")))
    .forEach((t) => { a = (!t.temporary || !t.returnDate || t.returnDate > dateISO) ? asAlloc(t.to) : asAlloc(t.from); });
  return a;
}

export function approvalsFor(from, to, pms) {
  const f = allocMap(from), t = allocMap(to);
  const out = [];
  [...new Set([...Object.keys(f), ...Object.keys(t)])].forEach((project) => {
    const d = (t[project] || 0) - (f[project] || 0);
    if (Math.abs(d) < 0.01) return;
    out.push({ project, role: d < 0 ? "give" : "take", delta: Math.abs(d), pm: (pms || {})[project] || "", status: "pending", by: "", at: "", comment: "" });
  });
  return out.sort((a, b) => a.role.localeCompare(b.role));
}

/* Заявка на переведення від PM: погодження проєктів-донорів (ті, що віддають людину).
   none — донорів немає, pending — хтось ще не відповів, approved — усі погодили, rejected — є заперечення. */
export function donorState(approvals) {
  const gives = (approvals || []).filter((a) => a.role === "give");
  if (!gives.length) return "none";
  if (gives.some((a) => a.status === "rejected")) return "rejected";
  return gives.every((a) => a.status === "approved") ? "approved" : "pending";
}

/* Переносить рішення PM із заявки в погодження переведення, створеного з неї
   (ті самі проєкти й ролі), щоб PM не питали вдруге. */
export function carryApprovals(list, from) {
  const src = new Map((from || []).filter((a) => a.status && a.status !== "pending").map((a) => [a.project + "|" + a.role, a]));
  return (list || []).map((a) => {
    const s = src.get(a.project + "|" + a.role);
    return s ? { ...a, status: s.status, by: s.by || "", at: s.at || "", comment: s.comment || "" } : a;
  });
}

export const isRequired = (a, mode) => (mode === "both" ? true : a.role === "give");
export function approvalState(t, mode) {
  const list = t.approvals || [];
  if (!list.length) return "none";
  if (list.some((a) => a.status === "rejected")) return "rejected";
  const req = list.filter((a) => isRequired(a, mode));
  if (!req.length || req.every((a) => a.status === "approved")) return "approved";
  return "pending";
}

// Тег: код-відсоток через кому, сума рівно 100 (залишки — найбільшим часткам).
export function tagOf(alloc, codes) {
  const rows = [];
  asAlloc(alloc).filter((x) => x.percent > 0).forEach((x) => {
    const code = (codes || {})[x.project] || "";
    const found = code && rows.find((r) => r.code === code);
    if (found) found.raw += x.percent; else rows.push({ code, raw: x.percent });
  });
  const s = rows.reduce((a, r) => a + r.raw, 0) || 1;
  rows.forEach((r) => { const v = (r.raw * 100) / s; r.pct = Math.floor(v); r.rest = v - r.pct; });
  let left = 100 - rows.reduce((a, r) => a + r.pct, 0);
  rows.slice().sort((a, b) => b.rest - a.rest).forEach((r) => { if (left > 0) { r.pct++; left--; } });
  return rows.filter((r) => r.pct > 0).map((r) => (r.code || "?") + "-" + r.pct).join(",");
}
