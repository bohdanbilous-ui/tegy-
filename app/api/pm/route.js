import { NextResponse } from "next/server";
import crypto from "crypto";
import { readState, writeState, readKey, writeKey } from "../../../lib/store";
import { whoIs } from "../../../lib/auth";
import { sameName } from "../../../lib/users";
import { workingOn } from "../../../lib/people";
import { orderProjects, isInactive } from "../../../lib/projects";
import { allocAt, asAlloc, approvalState, approvalsFor } from "../../../lib/alloc";
import { isPm, pmList } from "../../../lib/pms";
import { LOANS_KEY, PERIOD_RE, DATE_RE, MAX_LOAN_HOURS, periodRange, normHours, factNeeded, factSlots, lendersOf } from "../../../lib/loans";

export const dynamic = "force-dynamic";

/* Робоче місце PM. Проєкти PM — ті, де його ім'я стоїть у полі «PM, який погоджує»
   (Довідник → Проєкти; PM на проєкті може бути кілька, через «;»); ім'я береться з облікового запису на сервері.
   Будь-який PM проєкту діє від імені проєкту: погоджує, вносить і підтверджує факт, подає заявки.

   GET  — мої проєкти, люди на них, переведення на погодження, факт по переведеннях
          (що чекає на внесення, що внесено), заявки мої й колег-PM.
   POST { action: "decide", transferId, project, ok, comment }      — погодити / заперечити переведення.
   POST { action: "loan-save", id?, transferId, project, periodKey, hours | asPlanned, comment }
        — внести факт за завершену половину місяця для тимчасового / часткового переведення:
          скільки годин людина відпрацювала на проєкті, що її приймає, або «як заплановано».
   POST { action: "loan-delete", id }                                — прибрати непідтверджений запис.
   POST { action: "loan-decide", id, ok, comment }                   — підтвердити / відхилити факт
        (PM проєкту, звідки людина, або адміністратор). На теги впливають лише підтверджені години.
   POST { action: "loan-reopen", id }                                — зняти рішення (той самий PM або адміністратор).
   POST { action: "request", employeeId, alloc, effectiveDate, temporary, returnDate, reason, note }
        — заявка на переведення; потрапляє адміністратору у «Заявки». Проєкти, з яких людину забирають
          (донори), мають її погодити: запит одразу з'являється в їхніх PM. Там, де PM — сам заявник, погоджується автоматично.
   POST { action: "req-decide", requestId, project, ok, comment }    — PM проєкту-донора погоджує / заперечує заявку
        (достатньо будь-кого з PM проєкту; адміністратор може створити переведення й попри заперечення). */

const REQUESTS_KEY = "transfers:requests:v1";
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const nowISO = () => new Date().toISOString();
const kyivToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
const bad = (error, status = 400) => NextResponse.json({ error }, { status });
const uid = (p) => p + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
const low = (s) => String(s || "").trim().toLowerCase();

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
  const mine = new Set(allProjects.filter((p) => isPm(pms[p], me.name)));
  const employees = (state.employees || []).filter((e) => !tomb["e:" + e.id]);
  const transfers = (state.transfers || []).filter((t) => !tomb["t:" + t.id]).map((t) => ({ ...t, from: asAlloc(t.from), to: asAlloc(t.to) }));
  // Місяці, закриті у фін. обліку: теги там уже зафіксовані, факт їх не змінить.
  const closed = new Set((state.fin || []).filter((x) => x && String(x.id).startsWith("fc_") && x.closed).map((x) => String(x.id).slice(3)));
  // Колеги: усі PM моїх проєктів (разом зі мною).
  const colleagues = new Set([...mine].flatMap((p) => pmList(pms[p])).map(low));
  return { tomb, pms, allProjects, mine, employees, transfers, closed, colleagues, isAdmin: me.role === "admin" };
}

const workedIn = (emp, periodKey) => {
  const r = periodRange(periodKey);
  return !((emp.hiredOn && emp.hiredOn > r.to) || (emp.leftOn && emp.leftOn < r.from));
};

const transferInfo = (t) => (t ? {
  id: t.id, effectiveDate: t.effectiveDate, temporary: !!t.temporary, returnDate: t.returnDate || "", cancelled: !!t.cancelled,
  from: t.from, to: t.to, partner: t.partner || "",
} : null);

// Факт, який ще ніхто не вніс: тимчасові й часткові переведення × завершені половини місяця.
function todoFacts(c, loans, today) {
  const taken = new Set(loans.filter((l) => l.status !== "rejected").map((l) => l.employeeId + "|" + l.project + "|" + l.periodKey));
  const out = [];
  c.transfers.filter(factNeeded).forEach((t) => {
    const emp = c.employees.find((e) => e.id === t.employeeId);
    if (!emp) return;
    factSlots(t, today).forEach((s) => {
      if (!c.isAdmin && !c.mine.has(s.project)) return;
      if (!workedIn(emp, s.periodKey) || c.closed.has(s.periodKey.slice(0, 7))) return;
      if (taken.has(s.employeeId + "|" + s.project + "|" + s.periodKey)) return;
      out.push({ ...s, employeeName: emp.name, norm: normHours(s.periodKey), transfer: transferInfo(t) });
    });
  });
  return out.sort((a, b) => a.periodKey.localeCompare(b.periodKey) || a.employeeName.localeCompare(b.employeeName)).slice(0, 300);
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
  // Запити на людей з моїх проєктів: заявки PM, де мій проєкт — донор (мають погодити я або колега-PM).
  const cutoffISO = new Date(Date.now() - 120 * 86400000).toISOString();
  const needsMe = (r) => (r.approvals || []).some((a) => a.role === "give" && c.mine.has(a.project) && a.status === "pending");
  const incoming = requests.filter((r) => Array.isArray(r.approvals) && r.approvals.some((a) => a.role === "give" && c.mine.has(a.project)))
    .filter((r) => r.status === "new" || String(r.createdAt || "") >= cutoffISO)
    .sort((a, b) => Number(needsMe(b)) - Number(needsMe(a)) || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 100)
    .map((r) => ({
      id: r.id, status: r.status, requester: r.requester || "", employee: r.employee, employeeId: r.employeeId || "",
      from: r.from || [], alloc: r.alloc || [], effectiveDate: r.effectiveDate, temporary: !!r.temporary, returnDate: r.returnDate || "",
      reason: r.reason || "", note: r.note || "", approvals: r.approvals || [], createdAt: r.createdAt || "", comment: r.comment || "",
    }));
  const byId = new Map(c.transfers.map((t) => [t.id, t]));
  const myLoans = (c.isAdmin ? loans : loans.filter((l) => c.mine.has(l.project) || lendersOf(l).some((p) => c.mine.has(p)) || sameName(l.createdBy, me.name)))
    .map((l) => ({ ...l, lenderProjects: lendersOf(l), transfer: transferInfo(byId.get(l.transferId)) }));
  return {
    me: { name: me.name, role: me.role },
    myProjects: [...c.mine],
    projects: c.allProjects.filter((p) => !isInactive(state.projectMeta, p)),
    pms: Object.fromEntries(c.allProjects.map((p) => [p, pmList(c.pms[p]).join("; ")])),
    approvalMode: (state.settings || {}).approvalMode || "give",
    reasons: [...new Set((state.reasons || []).filter((r) => !c.tomb["r:" + r]))],
    people, onMine: onMine.map((p) => p.id),
    approvals,
    incoming,
    todo: todoFacts(c, loans, today),
    loans: myLoans.slice().sort((a, b) => b.periodKey.localeCompare(a.periodKey) || String(b.updatedAt).localeCompare(String(a.updatedAt))),
    requests: requests.filter((r) => sameName(r.requester, me.name) || c.colleagues.has(low(r.requester)))
      .slice(-50).reverse().map((r) => ({ ...r, own: sameName(r.requester, me.name) })),
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
  const { state, requests } = await load();
  const c = ctx(state, me);
  const stamp = nowISO();
  const today = kyivToday();
  const canAct = (project) => c.isAdmin || c.mine.has(project);
  const canLend = (l) => c.isAdmin || lendersOf(l).some((p) => c.mine.has(p));
  const pmNames = (project) => pmList(c.pms[project]).join(", ") || "адміністратор (у проєкту немає PM)";
  const log = (action, details) => ({ id: uid("l_pm"), at: stamp, who: me.name, email: "", action, details });
  // Два PM на проєкті можуть діяти одночасно: перед записом перечитуємо актуальні дані.
  const freshLoans = async () => ((await readKey(LOANS_KEY)) || []).slice();
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
    // Інший PM цього проєкту вже вирішив — не перезаписуємо мовчки (адміністратор може).
    if (a.status !== "pending" && a.by && !sameName(a.by, me.name) && !c.isAdmin) return bad("Це вже вирішив(ла) " + a.by + ". Якщо рішення треба змінити, зверніться до адміністратора.", 409);
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

  /* ── факт по переведенню: вносить PM проєкту, що приймає людину ── */
  if (body.action === "loan-save") {
    const project = str(body.project, 120), periodKey = str(body.periodKey, 10);
    if (!canAct(project)) return bad("Вносити факт може PM проєкту «" + project + "» або адміністратор.", 403);
    if (!PERIOD_RE.test(periodKey)) return bad("Оберіть період.");
    const t = c.transfers.find((x) => x.id === body.transferId);
    if (!t) return bad("Переведення не знайдено.", 404);
    if (t.cancelled) return bad("Переведення скасовано.", 409);
    if (!factNeeded(t)) return bad("Факт потрібен лише для тимчасових і часткових переведень.");
    const slot = factSlots(t, today).find((s) => s.project === project && s.periodKey === periodKey);
    if (!slot) return bad("Для цього переведення, проєкту й періоду факт не вносять: період ще не завершено, переведення тоді не діяло або проєкт його не приймає.");
    const emp = c.employees.find((e) => e.id === t.employeeId);
    if (!emp) return bad("Людину не знайдено.", 404);
    if (!workedIn(emp, periodKey)) return bad("У цьому періоді людина не працювала.");
    if (c.closed.has(periodKey.slice(0, 7))) return bad("Місяць уже закрито у фін. обліку: тег зафіксовано, факт його не змінить.", 409);
    const asPlanned = !!body.asPlanned;
    let hours = 0;
    if (!asPlanned) {
      hours = Math.round((Number(body.hours) || 0) * 100) / 100;
      if (!(hours > 0) || hours > MAX_LOAN_HOURS) return bad("Години мають бути від 0 до " + MAX_LOAN_HOURS + ", або позначте «як заплановано».");
      const norm = normHours(periodKey);
      if (hours > norm * 1.5) return bad("Забагато годин для періоду: норма " + norm + " год.");
    }
    const list = await freshLoans();
    const i = body.id ? list.findIndex((l) => l.id === body.id) : -1;
    if (body.id && i === -1) return bad("Запис не знайдено.", 404);
    if (i !== -1 && list[i].status === "confirmed") return bad("Факт уже підтверджено. Щоб змінити, PM проєкту «" + lendersOf(list[i]).join("», «") + "» має зняти підтвердження.", 409);
    if (i !== -1 && !canAct(list[i].project)) return bad("Цей запис належить іншому проєкту.", 403);
    // Один факт на людину, проєкт і період — навіть якщо його зачіпають кілька переведень.
    const dup = list.find((l, j) => j !== i && l.employeeId === emp.id && l.project === project && l.periodKey === periodKey && l.status !== "rejected");
    if (dup) return bad("За цей період для " + emp.name + " на проєкт «" + project + "» уже є запис — відредагуйте його.", 409);
    const rec = {
      ...(i !== -1 ? list[i] : { id: uid("ln_"), createdBy: me.name, createdAt: stamp }),
      transferId: t.id, employeeId: emp.id, employeeName: emp.name, project,
      lenderProjects: slot.lenders, lenderProject: slot.lenders[0] || "", rest: slot.rest,
      periodKey, hours, asPlanned, planHours: slot.planHours,
      comment: str(body.comment, 500), status: "pending", decidedBy: "", decidedAt: "", decisionComment: "", updatedAt: stamp, updatedBy: me.name,
    };
    if (i === -1) list.push(rec); else list[i] = rec;
    await writeKey(LOANS_KEY, list.slice(-3000));
    return done();
  }

  if (body.action === "loan-delete") {
    const list = await freshLoans();
    const i = list.findIndex((l) => l.id === body.id);
    if (i === -1) return bad("Запис не знайдено.", 404);
    if (!canAct(list[i].project)) return bad("Прибрати може PM проєкту, який вносив факт, або адміністратор.", 403);
    if (list[i].status === "confirmed" && !c.isAdmin) return bad("Підтверджені записи прибирає лише адміністратор.", 409);
    await writeKey(LOANS_KEY, list.filter((_, j) => j !== i));
    return done();
  }

  if (body.action === "loan-decide" || body.action === "loan-reopen") {
    const list = await freshLoans();
    const i = list.findIndex((l) => l.id === body.id);
    if (i === -1) return bad("Запис не знайдено.", 404);
    const l = list[i];
    if (!canLend(l)) return bad("Підтверджує PM проєкту «" + lendersOf(l).join("», «") + "», звідки людину взято, або адміністратор.", 403);
    if (!c.isAdmin && sameName(l.createdBy, me.name)) return bad("Власний запис підтверджувати не можна — це робить інший PM проєкту, звідки людина, або адміністратор.", 403);
    if (body.action === "loan-reopen") {
      if (l.status === "pending") return bad("Запис і так чекає на рішення.", 409);
      if (c.closed.has(l.periodKey.slice(0, 7)) && !c.isAdmin) return bad("Місяць закрито у фін. обліку.", 409);
      list[i] = { ...l, status: "pending", decidedBy: "", decidedAt: "", decisionComment: "", updatedAt: stamp, updatedBy: me.name };
    } else {
      if (l.status !== "pending") return bad("Рішення вже ухвалив(ла) " + (l.decidedBy || "інший PM") + ".", 409);
      const ok = !!body.ok, comment = str(body.comment, 500);
      if (!ok && !comment) return bad("Напишіть, чому відхиляєте.");
      list[i] = { ...l, status: ok ? "confirmed" : "rejected", decidedBy: me.name, decidedAt: stamp, decisionComment: comment, updatedAt: stamp, updatedBy: me.name };
    }
    await writeKey(LOANS_KEY, list);
    const fresh = (await readState()) || {};
    const x = list[i];
    fresh.log = [log(body.action === "loan-reopen" ? "зняв рішення щодо факту" : x.status === "confirmed" ? "підтвердив факт по переведенню" : "відхилив факт по переведенню",
      x.employeeName + " · " + lendersOf(x).join(" + ") + " → " + x.project + " · " + x.periodKey + " · " + (x.hours > 0 ? x.hours + " год" : "як заплановано")), ...(fresh.log || [])].slice(0, 300);
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
    // Хто віддає людину, той має погодити. Де PM проєкту — сам заявник, там погоджується автоматично.
    const cur = allocAt(emp, c.transfers, effectiveDate);
    const approvals = approvalsFor(cur, alloc, c.pms).map((a) => (isPm(c.pms[a.project], me.name)
      ? { ...a, status: "approved", by: me.name, at: stamp, comment: "подав(ла) заявку" } : a));
    if (!approvals.length) return bad("Новий розподіл збігається з поточним на цю дату — переводити нікуди.");
    if (!c.isAdmin && !approvals.some((a) => isPm(c.pms[a.project], me.name))) {
      return bad("Заявку подає PM проєкту, який приймає людину або з якого її забирають. Ви не PM жодного з проєктів цієї заявки.", 403);
    }
    const list = ((await readKey(REQUESTS_KEY)) || requests).slice();
    list.push({
      id: uid("rq_pm"), status: "new", source: "pm", requester: me.name, email: "",
      employee: emp.name, employeeId: emp.id, from: cur, alloc, effectiveDate, temporary, returnDate: temporary ? returnDate : "",
      reason: str(body.reason, 200), agreedWith: "", note: str(body.note, 2000), approvals,
      submittedAt: stamp, createdAt: stamp,
    });
    await writeKey(REQUESTS_KEY, list.slice(-500));
    return done();
  }

  /* ── рішення PM проєкту-донора щодо заявки ── */
  if (body.action === "req-decide") {
    const project = str(body.project, 120);
    if (!canAct(project)) return bad("Погоджувати може PM проєкту «" + project + "» або адміністратор.", 403);
    const list = ((await readKey(REQUESTS_KEY)) || []).slice();
    const i = list.findIndex((r) => r.id === body.requestId);
    if (i === -1) return bad("Заявку не знайдено.", 404);
    const r = list[i];
    if (r.status !== "new") return bad("Заявку вже опрацював адміністратор.", 409);
    const a = (r.approvals || []).find((x) => x.project === project && x.role === "give");
    if (!a) return bad("Ця заявка не забирає людей з проєкту «" + project + "».", 400);
    // Інший PM цього проєкту вже вирішив — не перезаписуємо мовчки (адміністратор може).
    if (a.status !== "pending" && a.by && !sameName(a.by, me.name) && !c.isAdmin) return bad("Це вже вирішив(ла) " + a.by + ". Якщо рішення треба змінити, зверніться до адміністратора.", 409);
    const ok = !!body.ok, comment = str(body.comment, 500);
    if (!ok && !comment) return bad("Напишіть, чому заперечуєте — заявник і адміністратор побачать коментар.");
    list[i] = { ...r, approvals: r.approvals.map((x) => (x.project === project && x.role === "give" ? { ...x, status: ok ? "approved" : "rejected", by: me.name, at: stamp, comment } : x)) };
    await writeKey(REQUESTS_KEY, list);
    const fresh = (await readState()) || {};
    fresh.log = [log(ok ? "погодив заявку на переведення" : "заперечив заявку на переведення", r.employee + " · " + project + (comment ? " · " + comment : "")), ...(fresh.log || [])].slice(0, 300);
    fresh.updatedAt = stamp; fresh.updatedBy = me.name;
    await writeState(fresh);
    return done();
  }

  return bad("Невідома дія.");
}
