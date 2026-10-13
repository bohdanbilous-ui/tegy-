import { NextResponse } from "next/server";
import crypto from "crypto";
import { readState, writeState, readKey, writeKey } from "../../../lib/store";
import { mergeState, nowISO } from "../../../lib/merge";
import { whoIs } from "../../../lib/auth";
import { pfConfigured, pullPeopleForce, applyPeople } from "../../../lib/peopleforce";
import { writePfInn } from "../../../lib/pay";
import { readChanges, writeChanges, addChanges } from "../../../lib/pfchanges";
import { allocAt, approvalsFor, asAlloc, sameAlloc, allocText, tagOf } from "../../../lib/alloc";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* Синхронізація довідника людей з PeopleForce.
   GET  з Authorization: Bearer CRON_SECRET — щоденний запуск Vercel Cron (vercel.json).
   GET  адміністратора — стан: чи налаштовано і що сталося востаннє.
   POST адміністратора — синхронізувати зараз.
   POST { action: "confirm", id, effectiveDate, alloc?, reason?, note?, applyPosition?, applyDivision? }
        — підтвердити зміну посади / БЮ: якщо розподіл інший, ніж на дату, створюється переведення
          (з нього рахується новий тег у фін. обліку й відомостях ЗП), картка людини оновлюється.
   POST { action: "dismiss", id, comment? } — відхилити зміну (у картці нічого не міняється).
   POST { action: "reopen", id } — повернути відхилену зміну в роботу. */

const LAST = "peopleforce:last:v1";
const kyivToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());

function cronOk(request) {
  const secret = process.env.CRON_SECRET || "";
  if (secret.length < 16) return false;
  const a = crypto.createHash("sha256").update(request.headers.get("authorization") || "").digest();
  const b = crypto.createHash("sha256").update("Bearer " + secret).digest();
  return crypto.timingSafeEqual(a, b);
}

async function admin(request) {
  const me = await whoIs(request);
  if (me.error) return { res: NextResponse.json({ error: me.error }, { status: 401 }) };
  if (!me.isAdmin) return { res: NextResponse.json({ error: "Синхронізацію запускає лише адміністратор." }, { status: 403 }) };
  return { me };
}

async function run(by) {
  const started = nowISO();
  if (!pfConfigured()) {
    const last = { at: started, by, ok: false, error: "Не задано PEOPLEFORCE_API_KEY у змінних Vercel." };
    await writeKey(LAST, last);
    return last;
  }
  try {
    const people = await pullPeopleForce();
    const stamp = nowISO();
    const { state, report } = applyPeople((await readState()) || {}, people, kyivToday(), stamp);
    // Перечитуємо стан перед записом: правки, що прийшли за час запиту до PeopleForce, не загубляться.
    const merged = mergeState(state, await readState());
    merged.updatedAt = stamp;
    merged.updatedBy = "PeopleForce";
    const changes = report.added.length + report.updated.length + report.left.length + report.returned.length + report.changes.length;
    if (changes) {
      merged.log = [{ id: "l_pf" + Date.now(), at: stamp, who: "PeopleForce", email: "", action: "синхронізував довідник",
        details: "нових " + report.added.length + ", оновлено " + report.updated.length + ", звільнено " + report.left.length +
          (report.changes.length ? ", змін посади / БЮ " + report.changes.length : "") }, ...(merged.log || [])].slice(0, 300);
    }
    // Записуємо й тоді, коли лише запам'ятали поточні посаду / БЮ (перша синхронізація).
    if (changes || report.baseline) await writeState(merged);
    if (report.changes.length) {
      const { store } = addChanges(await readChanges(), report.changes, kyivToday(), stamp);
      await writeChanges(store);
    }
    // ІПН з PeopleForce — в окреме сховище, лише для адміністратора (не в спільний стан).
    const pfToEmp = new Map((merged.employees || []).filter((e) => e.pfId).map((e) => [String(e.pfId), e.id]));
    const inn = {};
    people.forEach((p) => { const id = pfToEmp.get(String(p.pfId)); if (id && p.inn) inn[id] = p.inn; });
    await writePfInn(inn);
    const cut = (a) => a.slice(0, 50);
    const last = { at: stamp, by, ok: true, total: people.length, added: cut(report.added), updated: cut(report.updated),
      left: cut(report.left), returned: cut(report.returned), skipped: report.skipped, innFound: Object.keys(inn).length,
      changes: cut(report.changes.map((c) => c.name + ": " + describe(c))),
      counts: { added: report.added.length, updated: report.updated.length, left: report.left.length, returned: report.returned.length, changes: report.changes.length } };
    await writeKey(LAST, last);
    return last;
  } catch (e) {
    const last = { at: nowISO(), by, ok: false, error: String((e && e.message) || e).slice(0, 300) };
    await writeKey(LAST, last);
    return last;
  }
}

const describe = (c) => ["position", "division"].filter((k) => (c.fields || []).includes(k))
  .map((k) => (k === "position" ? "посада" : "БЮ") + " «" + (c.from[k] || "—") + "» → «" + (c.to[k] || "—") + "»").join("; ");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const bad = (error, status = 400) => NextResponse.json({ error }, { status });

async function decide(body, me) {
  const changes = await readChanges();
  const i = changes.items.findIndex((x) => x.id === body.id);
  if (i === -1) return bad("Зміну не знайдено.", 404);
  const item = changes.items[i];
  const stamp = nowISO();

  if (body.action === "dismiss" || body.action === "reopen") {
    if (body.action === "dismiss" && item.status !== "new") return bad("Цю зміну вже оброблено.", 409);
    if (body.action === "reopen" && item.status !== "dismissed") return bad("Повернути можна лише відхилену зміну.", 409);
    changes.items[i] = body.action === "dismiss"
      ? { ...item, status: "dismissed", comment: str(body.comment, 500), decidedBy: me.name, decidedAt: stamp, updatedAt: stamp }
      : { ...item, status: "new", comment: "", decidedBy: "", decidedAt: "", updatedAt: stamp };
    await writeChanges(changes);
    return NextResponse.json({ ok: true, item: changes.items[i], changes: changes.items, buMap: changes.buMap });
  }

  // confirm
  if (item.status !== "new") return bad("Цю зміну вже оброблено.", 409);
  const date = str(body.effectiveDate, 10);
  if (!DATE_RE.test(date)) return bad("Вкажіть дату, з якої діє зміна.");
  const state = (await readState()) || {};
  const tomb = state.deleted || {};
  const emp = (state.employees || []).find((e) => e.id === item.employeeId && !tomb["e:" + e.id]);
  if (!emp) return bad("Людини вже немає в довіднику.", 404);
  const transfers = (state.transfers || []).filter((t) => !tomb["t:" + t.id]).map((t) => ({ ...t, from: asAlloc(t.from), to: asAlloc(t.to) }));
  const cur = allocAt(emp, transfers, date);

  // Новий розподіл: проєкти з довідника, відсотки > 0, разом рівно 100.
  let alloc = null;
  if (Array.isArray(body.alloc) && body.alloc.length) {
    const known = new Set([...(state.projects || []).filter((p) => !tomb["p:" + p]), "Бенч",
      ...(state.employees || []).flatMap((e) => asAlloc(e.base).map((r) => r.project)),
      ...transfers.flatMap((t) => [...t.from, ...t.to].map((r) => r.project))]);
    alloc = [];
    for (const r of body.alloc) {
      const project = str(r && r.project, 120), percent = Math.round((Number(r && r.percent) || 0) * 100) / 100;
      if (!project || percent <= 0) continue;
      if (!known.has(project)) return bad("Проєкту «" + project + "» немає в довіднику.");
      const same = alloc.find((x) => x.project === project);
      if (same) same.percent += percent; else alloc.push({ project, percent });
    }
    const total = alloc.reduce((s, r) => s + r.percent, 0);
    if (Math.abs(total - 100) > 0.01) return bad("Розподіл має давати рівно 100%, зараз " + Math.round(total * 100) / 100 + "%.");
  }

  const codes = state.codes || {};
  const tagBefore = tagOf(cur, codes);
  let transfer = null;
  if (alloc && !sameAlloc(alloc, cur)) {
    const why = [item.fields.includes("division") && "БЮ", item.fields.includes("position") && "посади"].filter(Boolean).join(" і ");
    transfer = {
      id: "t_pf" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      employeeId: emp.id, employeeName: emp.name, from: cur, to: alloc, effectiveDate: date,
      temporary: false, returnDate: "",
      reason: str(body.reason, 200) || "Зміна " + why + " в PeopleForce",
      note: [str(body.note, 1000), describe(item)].filter(Boolean).join(" · "),
      approvals: approvalsFor(cur, alloc, state.pms), pfChangeId: item.id,
      partner: me.name, partnerEmail: "", createdAt: stamp, updatedAt: stamp, cancelled: false,
    };
  }
  const tagAfter = tagOf(transfer ? alloc : cur, codes);

  // Картка людини: нова посада / БЮ, якщо адміністратор не зняв галочку.
  const patch = {};
  if (body.applyPosition !== false && item.fields.includes("position")) patch.position = item.to.position || "";
  if (body.applyDivision !== false && item.fields.includes("division")) patch.division = item.to.division || "";

  const next = { ...state };
  next.employees = (state.employees || []).map((e) => (e.id === emp.id && Object.keys(patch).length ? { ...e, ...patch, updatedAt: stamp } : e));
  if (transfer) next.transfers = [transfer, ...(state.transfers || [])];
  next.log = [{ id: "l_pc" + Date.now().toString(36), at: stamp, who: me.name, email: "", action: "підтвердив зміну з PeopleForce",
    details: emp.name + ": " + describe(item) + (transfer ? " · " + allocText(cur) + " → " + allocText(alloc) + " з " + date : "") +
      " · тег " + (tagBefore || "—") + " → " + (tagAfter || "—") }, ...(state.log || [])].slice(0, 300);
  // Зливаємо з найсвіжішим станом: правки, що прийшли за цей час, не загубляться.
  const merged = mergeState(next, await readState());
  merged.updatedAt = stamp; merged.updatedBy = me.name;
  await writeState(merged);

  if (alloc && alloc.length === 1 && item.to.division) changes.buMap = { ...changes.buMap, [item.to.division]: alloc[0].project };
  changes.items[i] = { ...item, status: "confirmed", effectiveDate: date, transferId: transfer ? transfer.id : "",
    allocBefore: cur, allocAfter: transfer ? alloc : cur, tagBefore, tagAfter, applied: Object.keys(patch),
    decidedBy: me.name, decidedAt: stamp, updatedAt: stamp };
  await writeChanges(changes);
  return NextResponse.json({ ok: true, item: changes.items[i], changes: changes.items, buMap: changes.buMap });
}

export async function GET(request) {
  if (cronOk(request)) {
    const last = await run("щоденно");
    return NextResponse.json(last, { status: last.ok ? 200 : 502 });
  }
  const g = await admin(request);
  if (g.res) return g.res;
  const ch = await readChanges();
  return NextResponse.json({ configured: pfConfigured(), cron: (process.env.CRON_SECRET || "").length >= 16, last: await readKey(LAST), changes: ch.items, buMap: ch.buMap });
}

export async function POST(request) {
  const g = await admin(request);
  if (g.res) return g.res;
  const body = await request.json().catch(() => ({}));
  if (body && ["confirm", "dismiss", "reopen"].includes(body.action)) return decide(body, g.me);
  const last = await run(g.me.name);
  const ch = await readChanges();
  return NextResponse.json({ configured: pfConfigured(), cron: (process.env.CRON_SECRET || "").length >= 16, last, changes: ch.items, buMap: ch.buMap }, { status: last.ok ? 200 : 502 });
}
