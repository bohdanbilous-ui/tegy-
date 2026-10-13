import { NextResponse } from "next/server";
import crypto from "crypto";
import { readState, writeState, readKey, writeKey } from "../../../lib/store";
import { whoIs } from "../../../lib/auth";
import { sameName } from "../../../lib/users";
import { workingOn } from "../../../lib/people";
import { orderProjects, isInactive } from "../../../lib/projects";
import { allocAt, asAlloc, approvalState } from "../../../lib/alloc";
import { LOANS_KEY, PERIOD_RE, MAX_LOAN_HOURS, periodRange, normHours } from "../../../lib/loans";

export const dynamic = "force-dynamic";

/* Робоче місце PM. Проєкти PM — ті, де його ім'я стоїть у полі «PM, який погоджує»
   (Довідник → Проєкти); ім'я береться з облікового запису на сервері.
   GET  — мої проєкти, люди на них, переведення на погодження, позичання годин, мої заявки.
   POST { action: "decide", transferId, project, ok, comment }      — погодити / заперечити переведення.
   POST { action: "loan-save", id?, employeeId, project, periodKey, hours, lenderProject?, comment }
        — внести фактично відпрацьовані години людини, яку позичив мій проєкт.
   POST { action: "loan-delete", id }                                — прибрати свій непідтверджений запис.
   POST { action: "loan-decide", id, ok, comment }                   — підтвердити / відхилити години
        (PM проєкту, звідки людина, або адміністратор). На теги впливають лише підтверджені.
   POST { action: "loan-reopen", id }                                — зняти підтвердження (той самий PM або адміністратор).
   POST { action: "request", employeeId, alloc, effectiveDate, temporary, returnDate, reason, note }
        — заявка на переведення; потрапляє адміністратору у «Заявки». */

const REQUESTS_KEY = "transfers:requests:v1";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const nowISO = () => new Date().toISOString();
const kyivToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
const bad = (error, status = 400) => NextResponse.json({ error }, { status });
const uid = (p) => p + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");

async function gate(request) {
  const me = await whoIs(request);
  if (me.error) return { res: bad(me.error, 401) };
  if (me.role !== "pm" && me.role !== "admin") return { res: bad("Цей розділ — для PM і адміністратора.", 403) };
  return { me };
}

function ctx(state, me) {
  const tomb = state.deleted || {};
  const pms = state.pms || {};
  const live = (p) => p && !tomb["p:" + p];
  const allProjects = orderProjects((state.projects || []).filter(live), state.projectMeta);
  const mine = new Set(allProjects.filter((p) => sameName(pms[p], me.name)));
  const employees = (state.employees || []).filter((e) => !tomb["e:" + e.id]);
  const transfers = (state.transfers || []).filter((t) => !tomb["t:" + t.id]).map((t) => ({ ...t, from: asAlloc(t.from), to: asAlloc(t.to) }));
  return { tomb, pms, allProjects, mine, employees, transfers, isAdmin: me.role === "admin" };
}

// Звідки людину позичили: найбільша частка на початку періоду, крім проєкту-позичальника.
function lenderOf(emp, transfers, periodKey, borrower) {
  const a = allocAt(emp, transfers, periodRange(periodKey).from).filter((r) => r.project !== borrower && r.percent > 0);
  return a.sort((x, y) => y.percent - x.percent)[0]?.project || "";
}

function view(state, me, loans, requests) {
  const c = ctx(state, me);
  const today = kyivToday();
  const working = c.employees.filter((e) => workingOn(e, today));
  const people = working.map((e) => ({ id: e.id, name: e.name, position: e.position || "", alloc: allocAt(e, c.transfers, today) }));
  const onMine = people.filter((p) => p.alloc.some((r) => c.mine.has(r.project) && r.percent > 0));
  const touches = (t) => (t.approvals || []).some((a) => c.mine.has(a.project));
  const cutoff = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const approvals = c.transfers.filter((t) => !t.cancelled && touches(t))
    .filter((t) => (t.approvals || []).some((a) => c.mine.has(a.project) && a.status === "pending") || t.effectiveDate >= cutoff)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))
    .slice(0, 200)
    .map((t) => ({
      id: t.id, employeeName: t.employeeName || (c.employees.find((e) => e.id === t.employeeId) || {}).name || "", from: t.from, to: t.to,
      effectiveDate: t.effectiveDate, temporary: !!t.temporary, returnDate: t.returnDate || "", reason: t.reason || "", note: t.note || "",
      partner: t.partner || "", approvals: t.approvals || [], state: approvalState(t, (state.settings || {}).approvalMode),
    }));
  const myLoans = c.isAdmin ? loans : loans.filter((l) => c.mine.has(l.project) || c.mine.has(l.lenderProject) || sameName(l.createdBy, me.name));
  return {
    me: { name: me.name, role: me.role },
    myProjects: [...c.mine],
    projects: c.allProjects.filter((p) => !isInactive(state.projectMeta, p)),
    pms: Object.fromEntries(c.allProjects.map((p) => [p, c.pms[p] || ""])),
    approvalMode: (state.settings || {}).approvalMode || "give",
    reasons: [...new Set((state.reasons || []).filter((r) => !c.tomb["r:" + r]))],
    people, onMine: onMine.map((p) => p.id),
    approvals,
    loans: myLoans.slice().sort((a, b) => b.periodKey.localeCompare(a.periodKey) || String(b.updatedAt).localeCompare(String(a.updatedAt))),
    requests: requests.filter((r) => sameName(r.requester, me.name)).slice(-50).reverse(),
    today,
  };
}

async function load() {
  return { state: (await readState()) || {}, loans: (await readKey(LOANS_KEY)) || [], requests: (await readKey(REQUESTS_KEY)) || [] };
}

export async function GET(request) {
  const g = await gate(request);
  if (g.res) return g.res;
  const { state, loans, requests } = await load();
  return NextResponse.json(view(state, g.me, loans, requests));
}

export async function POST(request) {
  const g = await gate(request);
  if (g.res) return g.res;
  const me = g.me;
  let body;
  try { body = await request.json(); } catch (e) { return bad("Некоректний запит."); }
  const { state, loans, requests } = await load();
  const c = ctx(state, me);
  const stamp = nowISO();
  const canAct = (project) => c.isAdmin || c.mine.has(project);
  const log = (action, details) => ({ id: uid("l_pm"), at: stamp, who: me.name, email: "", action, details });
  const done = async () => NextResponse.json(view((await readState()) || {}, me, (await readKey(LOANS_KEY)) || [], (await readKey(REQUESTS_KEY)) || []));

  /* ── погодження переведення ── */
  if (body.action === "decide") {
    const project = str(body.project, 120);
    if (!canAct(project)) return bad("Погоджувати може PM проєкту «" + project + "» або адміністратор.", 403);
    const fresh = (await readState()) || {};
    const list = fresh.transfers || [];
    const i = list.findIndex((t) => t.id === body.transferId && !(fresh.deleted || {})["t:" + t.id]);
    if (i === -1) return bad("Переведення не знайдено.", 404);
    const t = list[i];
    if (t.cancelled) return bad("Переведення скасовано.", 409);
    const a = (t.approvals || []).find((x) => x.project === project);
    if (!a) return bad("Цього проєкту переведення не стосується.", 400);
    const ok = !!body.ok;
    const comment = str(body.comment, 500);
    if (!ok && !comment) return bad("Напишіть, чому заперечуєте — адміністратор побачить коментар.");
    list[i] = { ...t, updatedAt: stamp, approvals: (t.approvals || []).map((x) => (x.project !== project ? x : { ...x, status: ok ? "approved" : "rejected", by: me.name, at: stamp, comment })) };
    fresh.transfers = list;
    fresh.log = [log(ok ? "погодив переведення" : "заперечив переведення", (t.employeeName || "") + " · " + project + (comment ? " · " + comment : "")), ...(fresh.log || [])].slice(0, 300);
    fresh.updatedAt = stamp; fresh.updatedBy = me.name;
    await writeState(fresh);
    return done();
  }

  /* ── позичання: години ── */
  if (body.action === "loan-save") {
    const project = str(body.project, 120), periodKey = str(body.periodKey, 10);
    if (!canAct(project)) return bad("Вносити години може PM проєкту «" + project + "» або адміністратор.", 403);
    if (!PERIOD_RE.test(periodKey)) return bad("Оберіть період.");
    const hours = Math.round((Number(body.hours) || 0) * 100) / 100;
    if (!(hours > 0) || hours > MAX_LOAN_HOURS) return bad("Години мають бути від 0 до " + MAX_LOAN_HOURS + ".");
    const emp = c.employees.find((e) => e.id === body.employeeId);
    if (!emp) return bad("Людину не знайдено.", 404);
    const range = periodRange(periodKey);
    if ((emp.hiredOn && emp.hiredOn > range.to) || (emp.leftOn && emp.leftOn < range.from)) return bad("У цьому періоді людина не працювала.");
    const lenderProject = str(body.lenderProject, 120) || lenderOf(emp, c.transfers, periodKey, project);
    if (!lenderProject) return bad("На початку періоду людина повністю на проєкті «" + project + "» — позичати не було в кого. Якщо це не так, оберіть, звідки позичили.");
    if (lenderProject === project) return bad("Проєкт, звідки позичили, має відрізнятися від вашого.");
    const norm = normHours(periodKey);
    if (hours > norm * 1.5) return bad("Забагато годин для періоду: норма " + norm + " год.");
    const list = loans.slice();
    const i = body.id ? list.findIndex((l) => l.id === body.id) : -1;
    if (body.id && i === -1) return bad("Запис не знайдено.", 404);
    if (i !== -1 && list[i].status === "confirmed") return bad("Години вже підтверджено. Щоб змінити, попросіть PM проєкту «" + list[i].lenderProject + "» зняти підтвердження.", 409);
    if (i !== -1 && !canAct(list[i].project)) return bad("Цей запис вносив інший PM.", 403);
    const dup = list.find((l, j) => j !== i && l.employeeId === emp.id && l.project === project && l.periodKey === periodKey && l.status !== "rejected");
    if (dup) return bad("За цей період уже є запис для " + emp.name + " — відредагуйте його.", 409);
    const rec = {
      ...(i !== -1 ? list[i] : { id: uid("ln_"), createdBy: me.name, createdAt: stamp }),
      employeeId: emp.id, employeeName: emp.name, project, lenderProject, periodKey, hours,
      comment: str(body.comment, 500), status: "pending", decidedBy: "", decidedAt: "", decisionComment: "", updatedAt: stamp, updatedBy: me.name,
    };
    if (i === -1) list.push(rec); else list[i] = rec;
    await writeKey(LOANS_KEY, list.slice(-3000));
    return done();
  }

  if (body.action === "loan-delete") {
    const i = loans.findIndex((l) => l.id === body.id);
    if (i === -1) return bad("Запис не знайдено.", 404);
    if (!canAct(loans[i].project)) return bad("Прибрати може PM, який вносив години, або адміністратор.", 403);
    if (loans[i].status === "confirmed" && !c.isAdmin) return bad("Підтверджені години прибирає лише адміністратор.", 409);
    await writeKey(LOANS_KEY, loans.filter((_, j) => j !== i));
    return done();
  }

  if (body.action === "loan-decide" || body.action === "loan-reopen") {
    const list = loans.slice();
    const i = list.findIndex((l) => l.id === body.id);
    if (i === -1) return bad("Запис не знайдено.", 404);
    const l = list[i];
    if (!canAct(l.lenderProject)) return bad("Підтверджує PM проєкту «" + l.lenderProject + "», звідки позичили людину, або адміністратор.", 403);
    if (body.action === "loan-reopen") {
      if (l.status === "pending") return bad("Запис і так чекає на рішення.", 409);
      list[i] = { ...l, status: "pending", decidedBy: "", decidedAt: "", decisionComment: "", updatedAt: stamp, updatedBy: me.name };
    } else {
      if (l.status !== "pending") return bad("Рішення вже ухвалено.", 409);
      const ok = !!body.ok, comment = str(body.comment, 500);
      if (!ok && !comment) return bad("Напишіть, чому відхиляєте.");
      list[i] = { ...l, status: ok ? "confirmed" : "rejected", decidedBy: me.name, decidedAt: stamp, decisionComment: comment, updatedAt: stamp, updatedBy: me.name };
    }
    await writeKey(LOANS_KEY, list);
    const fresh = (await readState()) || {};
    const x = list[i];
    fresh.log = [log(body.action === "loan-reopen" ? "зняв підтвердження годин" : x.status === "confirmed" ? "підтвердив години позичання" : "відхилив години позичання",
      x.employeeName + " · " + x.lenderProject + " → " + x.project + " · " + x.periodKey + " · " + x.hours + " год"), ...(fresh.log || [])].slice(0, 300);
    fresh.updatedAt = stamp; fresh.updatedBy = me.name;
    await writeState(fresh);
    return done();
  }

  /* ── заявка на переведення ── */
  if (body.action === "request") {
    const emp = c.employees.find((e) => e.id === body.employeeId);
    if (!emp) return bad("Оберіть людину.");
    const effectiveDate = str(body.effectiveDate, 10);
    if (!DATE_RE.test(effectiveDate)) return bad("Вкажіть дату.");
    const alloc = [];
    for (const r of Array.isArray(body.alloc) ? body.alloc : []) {
      const project = str(r && r.project, 120), percent = Math.round((Number(r && r.percent) || 0) * 100) / 100;
      if (!project || percent <= 0) continue;
      if (percent > 100) return bad("Відсоток — не більше 100.");
      const same = alloc.find((x) => x.project === project);
      if (same) same.percent += percent; else alloc.push({ project, percent });
    }
    if (!alloc.length) return bad("Вкажіть хоча б один проєкт із відсотком.");
    const total = alloc.reduce((s, r) => s + r.percent, 0);
    if (Math.abs(total - 100) > 0.01) return bad("Розподіл має давати рівно 100%, зараз " + total + "%.");
    const temporary = !!body.temporary;
    const returnDate = str(body.returnDate, 10);
    if (temporary && (!DATE_RE.test(returnDate) || returnDate <= effectiveDate)) return bad("Для тимчасового переведення вкажіть дату повернення, пізнішу за дату переведення.");
    const list = requests.slice();
    list.push({
      id: uid("rq_pm"), status: "new", source: "pm", requester: me.name, email: "",
      employee: emp.name, employeeId: emp.id, alloc, effectiveDate, temporary, returnDate: temporary ? returnDate : "",
      reason: str(body.reason, 200), agreedWith: "", note: str(body.note, 2000),
      submittedAt: stamp, createdAt: stamp,
    });
    await writeKey(REQUESTS_KEY, list.slice(-500));
    return done();
  }

  return bad("Невідома дія.");
}
