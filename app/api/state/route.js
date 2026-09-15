import { NextResponse } from "next/server";
import { mergeState, nowISO } from "../../../lib/merge";
import { readState, writeState, persistent } from "../../../lib/store";
import { whoIs } from "../../../lib/auth";

export const dynamic = "force-dynamic";

const EMPTY = { employees: [], projects: [], partners: [], reasons: [], transfers: [], admins: [], log: [], deleted: {}, pms: {}, codes: {}, teams: [], entries: [], settings: { approvalMode: "give" } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Порівняння без урахування порядку ключів і службових полів.
const shape = (o, skip = []) => JSON.stringify(Object.keys(o || {}).filter((k) => !skip.includes(k)).sort().map((k) => [k, o[k]]));
const sameExcept = (a, b, skip) => shape(a, skip) === shape(b, skip);

/* Серверна перевірка прав. Клієнт надсилає весь стан, ми звіряємо його з
   тим, що лежить у сховищі, і відкидаємо правки чужих переведень.
   Адміністратор може все; автор — лише свої записи. */
function guard(stored, incoming, me) {
  const admins = stored.admins || [];
  const isAdmin = admins.some((a) => a.toLowerCase() === me.name.toLowerCase());
  if (isAdmin) return { ok: true };
  if (!(stored.employees || []).length && !(stored.transfers || []).length) return { ok: true }; // перше наповнення

  const mine = (t) => (t.partnerEmail && me.email && t.partnerEmail.toLowerCase() === me.email)
    || (t.partner || "").toLowerCase() === me.name.toLowerCase();
  const pms = stored.pms || {};
  const isPMof = (project) => (pms[project] || "").toLowerCase() === me.name.toLowerCase();
  const before = new Map((stored.transfers || []).map((t) => [t.id, t]));
  const after = new Map((incoming.transfers || []).map((t) => [t.id, t]));

  // Рішення PM — окреме право: підписати «погоджено» може лише PM того проєкту.
  const onlyApprovalsChanged = (old, next) => {
    if (!sameExcept(old, next, ["approvals", "updatedAt"])) return false;
    const a = old.approvals || [], b = next.approvals || [];
    if (a.length !== b.length) return false;
    return b.every((x, i) => {
      const y = a[i];
      if (!y || y.project !== x.project) return false;
      if (same(x, y)) return true;
      return isPMof(x.project) && x.by.toLowerCase() === me.name.toLowerCase();
    });
  };

  for (const [id, t] of after) {
    const old = before.get(id);
    if (!old) { if (!mine(t)) return { ok: false, why: "нове переведення має бути підписане вашим ім'ям" }; continue; }
    if (same(old, t)) continue;
    if (onlyApprovalsChanged(old, t)) continue;
    if (!mine(old)) return { ok: false, why: "правка чужого переведення" };
  }
  if (!same(stored.pms || {}, incoming.pms || {})) return { ok: false, why: "призначення PM — право адміністратора" };
  // Відсотки залученості команди вносить її відповідальний.
  const teamsBefore = new Map((stored.teams || []).map((t) => [t.id, t]));
  for (const t of incoming.teams || []) {
    const old = teamsBefore.get(t.id);
    if (!old || same(old, t)) continue;
    const owner = (old.owner || "").toLowerCase();
    if (owner !== me.name.toLowerCase()) return { ok: false, why: "відсотки команди «" + old.name + "» вносить " + (old.owner || "адміністратор") };
    if ((t.owner || "") !== (old.owner || "")) return { ok: false, why: "зміна відповідального — право адміністратора" };
    if ((t.name || "") !== (old.name || "")) return { ok: false, why: "перейменування команди — право адміністратора" };
  }
  // Табель: рядок може вносити лише відповідальний за команду цієї людини.
  const empTeam = new Map((stored.employees || []).map((e) => [e.id, e.teamId]));
  const teamById = new Map((stored.teams || []).map((t) => [t.id, t]));
  const entriesBefore = new Map((stored.entries || []).map((x) => [x.id, x]));
  for (const x of incoming.entries || []) {
    const old = entriesBefore.get(x.id);
    if (old && same(old, x)) continue;
    const team = teamById.get(empTeam.get(x.employeeId));
    if (!team) continue;
    if ((team.owner || "").toLowerCase() !== me.name.toLowerCase())
      return { ok: false, why: "табель команди «" + team.name + "» веде " + (team.owner || "адміністратор") };
    if ((team.submitted || {})[x.periodKey])
      return { ok: false, why: "період уже поданий — відкрити може адміністратор" };
  }
  if (!same(stored.settings || {}, incoming.settings || {})) return { ok: false, why: "зміна налаштувань погодження — право адміністратора" };
  // Відсутність запису в тілі запиту — не видалення: злиття поверне його зі сховища.
  // Видаленням вважається лише явний «надгробок», і його ставити можна тільки на своє.
  for (const [id, t] of before) {
    const tombNew = (incoming.deleted || {})["t:" + id];
    const tombOld = (stored.deleted || {})["t:" + id];
    if (tombNew && tombNew !== tombOld && !mine(t)) return { ok: false, why: "видалення чужого переведення" };
  }
  if (!same([...(stored.admins || [])].sort(), [...(incoming.admins || [])].sort()))
    return { ok: false, why: "зміна списку адміністраторів" };
  for (const e of stored.employees || []) {
    const tombNew = (incoming.deleted || {})["e:" + e.id];
    if (tombNew && tombNew !== (stored.deleted || {})["e:" + e.id]) return { ok: false, why: "видалення людей з довідника — це право адміністратора" };
  }
  return { ok: true };
}

export async function GET(request) {
  const me = await whoIs(request);
  if (me.error) return NextResponse.json({ error: me.error }, { status: 401 });
  const stored = (await readState()) || EMPTY;
  return NextResponse.json({ ...EMPTY, ...stored, _persistent: persistent });
}

export async function PUT(request) {
  const me = await whoIs(request);
  if (me.error) return NextResponse.json({ error: me.error }, { status: 401 });

  let incoming;
  try { incoming = await request.json(); }
  catch (e) { return NextResponse.json({ error: "Некоректний запит." }, { status: 400 }); }

  const stored = (await readState()) || EMPTY;
  const verdict = guard(stored, incoming, me);
  if (!verdict.ok) return NextResponse.json({ error: verdict.why }, { status: 403 });

  const merged = mergeState(incoming, stored);
  merged.updatedAt = nowISO();
  merged.updatedBy = me.name;
  await writeState(merged);
  return NextResponse.json({ ...merged, _persistent: persistent });
}
