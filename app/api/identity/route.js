import { NextResponse } from "next/server";
import { readState, readKey, writeKey } from "../../../lib/store";
import { whoIs } from "../../../lib/auth";
import { matchTrackerUsers } from "../../../lib/recon";
import { IDENT_KEY, SYSTEMS, cleanIdent, upsertAccount } from "../../../lib/identity";

export const dynamic = "force-dynamic";

/* Довідник «Трекери»: хто як записаний у ClickUp / Redmine.
   GET  — адміністратор: співробітники з їхніми акаунтами, покриття.
   POST { action: "import", sys, rows: [{name,email,status}] } — збіг за email, потім за ПІБ; схожі імена лише підказуємо.
   POST { action: "link", sys, person, email?, employeeId } / { action: "unlink", employeeId, sys, person, email? } */

const bad = (error, status = 400) => NextResponse.json({ error }, { status });
const nowISO = () => new Date().toISOString();
const low = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

async function gate(request) {
  const me = await whoIs(request);
  if (me.error) return { res: bad(me.error, 401) };
  if (me.role !== "admin") return { res: bad("Це може лише адміністратор.", 403) };
  return { me };
}
async function load() {
  const state = (await readState()) || {};
  const tomb = state.deleted || {};
  const employees = (state.employees || []).filter((e) => !tomb["e:" + e.id]);
  const teams = new Map((state.teams || []).map((t) => [t.id, t.name]));
  const ident = cleanIdent(await readKey(IDENT_KEY), new Set(employees.map((e) => e.id)));
  return { employees, teams, ident };
}
function view(d, report) {
  const people = d.employees.map((e) => ({ id: e.id, name: e.name, email: e.email || "", team: d.teams.get(e.teamId) || "", accounts: d.ident[e.id] || [] }))
    .sort((a, b) => a.name.localeCompare(b.name, "uk"));
  return { systems: SYSTEMS, people, coverage: { total: people.length, linked: people.filter((p) => p.accounts.length).length }, report };
}

export async function GET(request) {
  const g = await gate(request); if (g.res) return g.res;
  return NextResponse.json(view(await load()));
}

export async function POST(request) {
  const g = await gate(request); if (g.res) return g.res;
  let b; try { b = await request.json(); } catch (e) { return bad("Некоректний запит."); }
  const d = await load();
  const sys = SYSTEMS[b.sys] ? b.sys : "other";
  let report;
  if (b.action === "import") {
    const users = (Array.isArray(b.rows) ? b.rows : []).slice(0, 2000);
    if (!users.length) return bad("У файлі не знайдено користувачів (потрібні колонки з ім'ям та email).");
    const m = matchTrackerUsers(users, d.employees);
    let added = 0;
    m.matched.forEach((x) => {
      const before = JSON.stringify(d.ident[x.employeeId] || []);
      d.ident = upsertAccount(d.ident, x.employeeId, { sys, name: x.person, email: x.email, status: x.status, at: nowISO() });
      if (JSON.stringify(d.ident[x.employeeId]) !== before) added++;
    });
    await writeKey(IDENT_KEY, d.ident);
    report = { sys, total: m.matched.length + m.suggested.length + m.none.length, byEmail: m.matched.filter((x) => x.by === "email").length, byName: m.matched.filter((x) => x.by === "name").length, saved: added, suggested: m.suggested.slice(0, 300), none: m.none.slice(0, 300) };
  } else if (b.action === "link") {
    const emp = d.employees.find((e) => e.id === b.employeeId);
    const name = String(b.person || "").trim(), email = low(b.email);
    if (!emp || (!name && !email)) return bad("Оберіть співробітника й вкажіть ім'я або email з трекера.");
    d.ident = upsertAccount(d.ident, emp.id, { sys, name: name.slice(0, 120), email: email.slice(0, 160), status: "", at: nowISO() });
    await writeKey(IDENT_KEY, cleanIdent(d.ident));
  } else if (b.action === "unlink") {
    const list = (d.ident[b.employeeId] || []).filter((a) => !(a.sys === sys && low(a.name) === low(b.person) && a.email === low(b.email)));
    d.ident = { ...d.ident, [b.employeeId]: list };
    await writeKey(IDENT_KEY, cleanIdent(d.ident));
  } else return bad("Невідома дія.");
  d.ident = cleanIdent(d.ident, new Set(d.employees.map((e) => e.id)));
  return NextResponse.json(view(d, report));
}
