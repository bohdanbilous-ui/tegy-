import { NextResponse } from "next/server";
import { mergeState, nowISO } from "../../../lib/merge";
import { readState, writeState, persistent } from "../../../lib/store";
import { whoIs } from "../../../lib/auth";
import { sameName } from "../../../lib/users";

export const dynamic = "force-dynamic";

const EMPTY = { employees: [], projects: [], partners: [], reasons: [], transfers: [], admins: [], log: [], deleted: {}, pms: {}, codes: {}, teams: [], entries: [], fin: [], settings: { approvalMode: "give" } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byId = (list) => new Map((list || []).map((x) => [x.id, x]));
const newer = (a, b) => (a && a.updatedAt || "") > (b && b.updatedAt || "");

/* Повний застосунок відкривають дві ролі:
   admin — бачить і править усе;
   hrd   — бачить людей, проєкти й переведення, створює та править СВОЇ
           переведення і веде табель лише своїх команд.
   Відповідальні (owner) працюють через /api/team.
   Роль береться з облікового запису на сервері, а не з тіла запиту. */
async function desk(request) {
  const me = await whoIs(request);
  if (me.error) return { res: NextResponse.json({ error: me.error }, { status: 401 }) };
  if (me.role !== "admin" && me.role !== "hrd") {
    return { res: NextResponse.json({ error: "Цей розділ доступний адміністратору та HRD." }, { status: 403 }) };
  }
  return { me };
}

const ownTeams = (state, me) => new Set((state.teams || []).filter((t) => sameName(t.owner, me.name)).map((t) => t.id));

function viewFor(state, me) {
  // _now — час сервера: клієнт вирівнює за ним свої позначки часу правок.
  const full = { ...EMPTY, ...state, _persistent: persistent, _view: me.role, _now: nowISO() };
  if (me.role === "admin") return full;
  const own = ownTeams(state, me);
  const ownPeople = new Set((state.employees || []).filter((e) => own.has(e.teamId)).map((e) => e.id));
  return {
    ...full,
    teams: (state.teams || []).filter((t) => own.has(t.id)),
    entries: (state.entries || []).filter((x) => ownPeople.has(x.employeeId)),
    log: (state.log || []).filter((l) => sameName(l.who, me.name)),
    fin: [], // місяць для фін. обліку — лише адміністратор
  };
}

/* Перевірка правок HRD. Застарілі копії чужих записів (з давнішою позначкою
   часу) не вважаються правкою — злиття однаково лишить серверну версію.
   Повертає текст помилки або null. Позначки часу правок лишаються клієнтськими
   (клієнт вирівнює їх за _now сервера): якби сервер ставив свій час, відповідь
   на старіший запит «перемагала» б цифри, введені, поки запит ішов. */
function guardHrd(stored, inc, me) {
  const stamp = nowISO();
  const mine = (t) => sameName(t.partner, me.name);
  const tomb = stored.deleted || {};
  // Видаляти й відновлювати записи може лише адміністратор.
  inc.deleted = tomb;

  // Переведення: нові — лише від свого імені, правити — лише свої.
  const tBefore = byId(stored.transfers);
  for (const t of inc.transfers || []) {
    const old = tBefore.get(t.id);
    if (!old && tomb["t:" + t.id]) continue;
    if (!old) {
      if (!mine(t)) return "нове переведення має бути підписане вашим ім'ям";
      t.partner = me.name;
      t.approvals = (t.approvals || []).map((a) => ({ ...a, status: "pending", by: "", at: "", comment: "" }));
      t.createdAt = t.createdAt || stamp;
      continue;
    }
    if (same(old, t) || !newer(t, old)) continue;
    if (!mine(old) || !mine(t)) return "правити можна лише свої переведення";
    // Погодження ставить PM: якщо розподіл не змінився, лишаємо їх як на сервері.
    if (same(old.to, t.to)) t.approvals = old.approvals || [];
  }

  // Довідник людей і проєктів HRD не змінює.
  const eBefore = byId(stored.employees);
  for (const e of inc.employees || []) {
    const old = eBefore.get(e.id);
    if (!old && tomb["e:" + e.id]) continue;
    if (!old) return "додавати людей до довідника може лише адміністратор";
    if (!same(old, e) && newer(e, old)) return "змінювати довідник людей може лише адміністратор";
  }
  const known = new Set(stored.projects || []);
  if ((inc.projects || []).some((p) => !known.has(p) && !tomb["p:" + p])) return "додавати проєкти може лише адміністратор";
  const knownPP = new Set(stored.partners || []);
  if ((inc.partners || []).some((p) => !knownPP.has(p) && !tomb["pp:" + p])) return "змінювати список People Partners може лише адміністратор";

  // Налаштування, PM і коди — лише адміністратор: беремо серверні значення.
  inc.pms = stored.pms || {};
  inc.codes = stored.codes || {};
  inc.settings = stored.settings || {};
  inc.admins = stored.admins || [];
  inc.fin = stored.fin || [];
  inc.log = (inc.log || []).filter((l) => sameName(l.who, me.name));

  // Команди: лише свої, і лише подання періоду.
  const own = ownTeams(stored, me);
  const tmBefore = byId(stored.teams);
  for (const t of inc.teams || []) {
    const old = tmBefore.get(t.id);
    if (!old && tomb["tm:" + t.id]) continue;
    if (!old) return "створювати команди може лише адміністратор";
    if (same(old, t) || !newer(t, old)) continue;
    if (!own.has(t.id)) return "табель команди «" + old.name + "» веде " + (old.owner || "адміністратор");
    const { submitted: s1, updatedAt: u1, updatedBy: b1, ...restOld } = old;
    const { submitted: s2, updatedAt: u2, updatedBy: b2, ...restNew } = t;
    if (!same(restOld, restNew)) return "змінювати команду може лише адміністратор";
    const before = s1 || {}, after = s2 || {};
    for (const k of Object.keys(before)) {
      if (!same(before[k], after[k])) return "відкрити поданий період може лише адміністратор";
    }
    for (const k of Object.keys(after)) if (!before[k]) after[k] = { by: me.name, at: stamp };
    t.updatedBy = me.name;
  }

  // Табель: лише люди своїх команд і лише неподані періоди.
  const empTeam = new Map((stored.employees || []).map((e) => [e.id, e.teamId]));
  const enBefore = byId(stored.entries);
  for (const x of inc.entries || []) {
    const old = enBefore.get(x.id);
    if (old && (same(old, x) || !newer(x, old))) continue;
    const team = tmBefore.get(empTeam.get(x.employeeId));
    if (!team || !own.has(team.id)) return "вносити відсотки можна лише для людей своєї команди";
    if ((team.submitted || {})[x.periodKey]) return "період уже подано — відкрити його може адміністратор";
    x.updatedBy = me.name;
  }
  return null;
}

export async function GET(request) {
  const g = await desk(request);
  if (g.res) return g.res;
  const stored = (await readState()) || EMPTY;
  return NextResponse.json(viewFor(stored, g.me));
}

export async function PUT(request) {
  const g = await desk(request);
  if (g.res) return g.res;

  let incoming;
  try { incoming = await request.json(); }
  catch (e) { return NextResponse.json({ error: "Некоректний запит." }, { status: 400 }); }

  const stored = (await readState()) || EMPTY;
  if (g.me.role === "hrd") {
    const why = guardHrd(stored, incoming, g.me);
    if (why) return NextResponse.json({ error: why }, { status: 403 });
  }
  const merged = mergeState(incoming, stored);
  merged.updatedAt = nowISO();
  merged.updatedBy = g.me.name;
  await writeState(merged);
  return NextResponse.json(viewFor(merged, g.me));
}
