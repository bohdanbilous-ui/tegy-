// Що чекає на кожного PM: сповіщення в Slack (нагадування). Лише сервер.
// Рахує те саме, що показує кабінет PM (app/api/pm): запити на його людей, переведення на погодження,
// факт, який треба внести, і факт, який треба підтвердити.
import { pmList, isPm } from "./pms";
import { asAlloc } from "./alloc";
import { factNeeded, factSlots, loanFits, periodRange, lendersOf } from "./loans";
import { sameName } from "./users";

const low = (s) => String(s || "").trim().toLowerCase();
const plural = (n, a, b, c) => { const m = n % 100; if (m > 10 && m < 20) return c; const k = n % 10; return k === 1 ? a : k > 1 && k < 5 ? b : c; };

export function pmDigest(state, loans, requests, today) {
  const tomb = state.deleted || {};
  const pms = state.pms || {};
  const projects = (state.projects || []).filter((p) => p && !tomb["p:" + p]);
  const employees = (state.employees || []).filter((e) => !tomb["e:" + e.id]);
  const empById = new Map(employees.map((e) => [e.id, e]));
  const transfers = (state.transfers || []).filter((t) => !tomb["t:" + t.id]).map((t) => ({ ...t, from: asAlloc(t.from), to: asAlloc(t.to) }));
  const tById = new Map(transfers.map((t) => [t.id, t]));
  const closed = new Set((state.fin || []).filter((x) => x && String(x.id).startsWith("fc_") && x.closed).map((x) => String(x.id).slice(3)));
  const cutoff = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const workedIn = (emp, key) => { const r = periodRange(key); return !((emp.hiredOn && emp.hiredOn > r.to) || (emp.leftOn && emp.leftOn < r.from)); };
  const taken = new Set((loans || []).filter((l) => l.status !== "rejected").map((l) => l.employeeId + "|" + l.project + "|" + l.periodKey));

  // Слоти факту: один раз на всіх (по проєкту, що приймає).
  const slots = [];
  transfers.filter(factNeeded).forEach((t) => {
    const emp = empById.get(t.employeeId);
    if (!emp) return;
    factSlots(t, today).forEach((s) => {
      if (!workedIn(emp, s.periodKey) || closed.has(s.periodKey.slice(0, 7))) return;
      if (taken.has(s.employeeId + "|" + s.project + "|" + s.periodKey)) return;
      slots.push(s);
    });
  });

  const names = new Map();
  projects.forEach((p) => pmList(pms[p]).forEach((n) => { if (!names.has(low(n))) names.set(low(n), n); }));

  const out = [];
  names.forEach((name) => {
    const mine = new Set(projects.filter((p) => isPm(pms[p], name)));
    const q = (requests || []).filter((r) => r.status === "new" && (r.approvals || []).some((a) => a.role === "give" && a.status === "pending" && mine.has(a.project))).length;
    const ap = transfers.filter((t) => !t.cancelled && t.effectiveDate >= cutoff
      && (t.approvals || []).some((a) => a.status === "pending" && mine.has(a.project) && (a.role === "give" || (state.settings || {}).approvalMode === "both"))).length;
    const facts = slots.filter((s) => mine.has(s.project)).length;
    const confirms = (loans || []).filter((l) => l.status === "pending" && lendersOf(l).some((p) => mine.has(p))
      && !sameName(l.createdBy, name) && !closed.has(String(l.periodKey).slice(0, 7)) && loanFits(l, tById.get(l.transferId))).length;
    out.push({ name, requests: q, approvals: ap, facts, confirms, total: q + ap + facts + confirms });
  });
  return out;
}

export function pmText(row, url) {
  const first = String(row.name || "").trim().split(/\s+/)[1] || String(row.name || "").trim().split(/\s+/)[0] || "";
  const lines = [];
  if (row.requests) lines.push("• " + row.requests + " " + plural(row.requests, "запит", "запити", "запитів") + " на людей з ваших проєктів — треба погодити або заперечити");
  if (row.approvals) lines.push("• " + row.approvals + " " + plural(row.approvals, "переведення", "переведення", "переведень") + " на погодження");
  if (row.facts) lines.push("• " + row.facts + " " + plural(row.facts, "запис", "записи", "записів") + " факту годин — внести, скільки людина відпрацювала у вас");
  if (row.confirms) lines.push("• " + row.confirms + " " + plural(row.confirms, "запис", "записи", "записів") + " факту — підтвердити години людей, яких ви віддали");
  return "Привіт, " + first + "! 👋 У Allocate на вас чекає:\n" + lines.join("\n") + "\n\nКабінет PM: " + url + " (вхід під своїм логіном).";
}
