import { NextResponse } from "next/server";
import { readState, readKey, writeKey } from "../../../lib/store";
import { whoIs } from "../../../lib/auth";
import { sameName } from "../../../lib/users";
import { isPm } from "../../../lib/pms";
import { orderProjects } from "../../../lib/projects";
import { PERIOD_RE, periodRange, keyOfDate, prevKey, addDays } from "../../../lib/loans";
import { HOURS_KEY, CONF_KEY, CFG_KEY, ACTIONS, cleanCfg, reconRows, needsDecision, fingerprint, parseHoursText, rowKey, unmatchedHours } from "../../../lib/recon";

export const dynamic = "force-dynamic";

/* Звірка PM: план за Allocate проти годин з трекерів.
   GET  ?period=2026-11-H1 — PM/адміністратор: рядки звірки по своїх проєктах; бухгалтер: лише статус проєктів.
   POST { action: "hours-set", period, text }   — адміністратор: завантажити години («людина; проєкт; години»).
   POST { action: "hours-clear", period }       — адміністратор.
   POST { action: "cfg-set", tol, tolSmall, smallUpTo } — адміністратор: допуск у п.п.
   POST { action: "resolve", period, employeeId, project, kind: plan|tracker|manual, comment, hours? } — PM: рішення по рядку.
   POST { action: "resolve-clear", period, employeeId, project }
   POST { action: "confirm", period }           — PM: підтвердити звірку своїх проєктів (усі відхилення мають рішення).
   POST { action: "reopen", period, project }   — PM проєкту: зняти підтвердження. */

const DEPUTIES_KEY = "pm:deputies:v1";
const bad = (error, status = 400) => NextResponse.json({ error }, { status });
const nowISO = () => new Date().toISOString();
const kyivToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

async function gate(request) {
  const me = await whoIs(request);
  if (me.error) return { res: bad(me.error, 401) };
  if (!["pm", "admin", "accountant"].includes(me.role)) return { res: bad("Звірка доступна PM, адміністратору й бухгалтеру.", 403) };
  return { me };
}

function liveProjects(state) {
  const tomb = state.deleted || {};
  return orderProjects((state.projects || []).filter((p) => p && !tomb["p:" + p]), state.projectMeta);
}

// Проєкти користувача: PM — свої та колег, яких заступає; адміністратор і бухгалтер — усі.
function projectsOf(state, me, deputies) {
  const all = liveProjects(state);
  if (me.role !== "pm") return new Set(all);
  const today = kyivToday();
  const cover = (deputies || []).filter((d) => sameName(d.deputy, me.name) && d.from <= today && d.to >= today);
  const pms = state.pms || {};
  return new Set(all.filter((p) => isPm(pms[p], me.name) || cover.some((d) => isPm(pms[p], d.pm))));
}

// Остання завершена половина місяця (за замовчуванням).
function lastFinished(today) {
  let key = keyOfDate(addDays(today, -1));
  if (periodRange(key).to >= today) key = prevKey(key);
  return key;
}

async function load(period) {
  const [state, hoursAll, confAll, cfg, deputies] = await Promise.all([
    readState(), readKey(HOURS_KEY), readKey(CONF_KEY), readKey(CFG_KEY), readKey(DEPUTIES_KEY),
  ]);
  return {
    state: state || {}, hours: (hoursAll || {})[period] || null, hoursAll: hoursAll || {},
    conf: (confAll || {})[period] || { res: {}, ok: {} }, confAll: confAll || {},
    cfg: cleanCfg(cfg), deputies: deputies || [],
  };
}

function build(d, me, period) {
  const today = kyivToday();
  const projects = projectsOf(d.state, me, d.deputies);
  const tomb = d.state.deleted || {};
  const employees = (d.state.employees || []).filter((e) => !tomb["e:" + e.id]);
  const transfers = (d.state.transfers || []).filter((t) => !tomb["t:" + t.id]);
  const rows = reconRows({ key: period, employees, transfers, projects, hours: d.hours, res: d.conf.res, cfg: d.cfg, entries: d.state.entries });
  const finished = periodRange(period).to < today;
  const byProject = {};
  rows.forEach((r) => { (byProject[r.project] = byProject[r.project] || []).push(r); });
  const summary = Object.keys(byProject).map((project) => {
    const list = byProject[project];
    const ok = d.conf.ok[project] || null;
    const fp = fingerprint(list);
    const open = list.filter(needsDecision).length;
    return {
      project, people: list.length, warn: list.filter((r) => r.state === "warn").length, open,
      state: ok ? (ok.fp === fp ? "confirmed" : "stale") : "open",
      by: ok ? ok.by : "", at: ok ? ok.at : "", fp,
    };
  });
  const unmatched = me.role === "pm" ? undefined : unmatchedHours({ hours: d.hours, employees, projects: liveProjects(d.state) });
  const base = { period, today, finished, cfg: d.cfg, unmatched, hours: d.hours ? { at: d.hours.at, by: d.hours.by, count: d.hours.rows.length } : null, summary };
  if (me.role === "accountant") return base;
  return { ...base, rows, me: { name: me.name, role: me.role }, actions: ACTIONS, defaultPeriod: lastFinished(today) };
}

export async function GET(request) {
  const g = await gate(request);
  if (g.res) return g.res;
  const url = new URL(request.url);
  const q = url.searchParams.get("period");
  const period = q && PERIOD_RE.test(q) ? q : lastFinished(kyivToday());
  return NextResponse.json(build(await load(period), g.me, period));
}

export async function POST(request) {
  const g = await gate(request);
  if (g.res) return g.res;
  const me = g.me;
  let b; try { b = await request.json(); } catch (e) { return bad("Некоректний запит."); }
  const period = String(b.period || "");
  if (b.action !== "cfg-set" && !PERIOD_RE.test(period)) return bad("Невірний період.");
  const d = await load(period);
  const reply = () => NextResponse.json(build(d, me, period));
  const isAdmin = me.role === "admin";

  if (b.action === "hours-set" || b.action === "hours-clear" || b.action === "cfg-set") {
    if (!isAdmin) return bad("Це може лише адміністратор.", 403);
    if (b.action === "cfg-set") {
      await writeKey(CFG_KEY, cleanCfg(b));
      d.cfg = cleanCfg(b);
      return NextResponse.json(build(d, me, PERIOD_RE.test(period) ? period : lastFinished(kyivToday())));
    }
    const next = { ...d.hoursAll };
    if (b.action === "hours-clear") delete next[period];
    else {
      const p = parseHoursText(b.text);
      if (!p.rows.length) return bad("Не знайдено жодного рядка «людина; проєкт; години».");
      if (p.bad.length) return bad("Не вдалося прочитати рядки: " + p.bad.slice(0, 8).join(", ") + (p.bad.length > 8 ? "…" : "") + ". Формат: Прізвище Ім'я; Проєкт; 80");
      next[period] = { at: nowISO(), by: me.name, rows: p.rows };
      d.hours = next[period];
    }
    await writeKey(HOURS_KEY, next);
    if (b.action === "hours-clear") d.hours = null;
    return reply();
  }

  if (me.role === "accountant") return bad("Бухгалтер лише переглядає статус звірки.", 403);
  const mine = projectsOf(d.state, me, d.deputies);
  const save = async () => { await writeKey(CONF_KEY, { ...d.confAll, [period]: d.conf }); };

  if (b.action === "resolve" || b.action === "resolve-clear") {
    const project = String(b.project || ""), empId = String(b.employeeId || "");
    if (!mine.has(project)) return bad("Це не ваш проєкт.", 403);
    const k = rowKey(empId, project);
    if (b.action === "resolve-clear") { delete d.conf.res[k]; await save(); return reply(); }
    if (!ACTIONS[b.kind]) return bad("Оберіть дію.");
    const comment = str(b.comment, 500);
    if (comment.length < 3) return bad("Напишіть коментар — що саме сталося.");
    let hours;
    if (b.kind === "manual") {
      hours = Number(String(b.hours).replace(",", "."));
      if (!Number.isFinite(hours) || hours < 0 || hours > 744) return bad("Вкажіть години від 0 до 744.");
    }
    d.conf.res[k] = { action: b.kind, comment, ...(hours != null ? { hours } : {}), by: me.name, at: nowISO() };
    await save();
    return reply();
  }

  if (b.action === "confirm") {
    if (!d.hours) return bad("За цей період години ще не завантажені — звіряти нема з чим.");
    if (periodRange(period).to >= kyivToday()) return bad("Період ще не завершився.");
    const built = build(d, me, period);
    const mineSummary = built.summary.filter((s) => mine.has(s.project));
    if (!mineSummary.length) return bad("На ваших проєктах немає людей за цей період.");
    const open = built.rows.filter((r) => mine.has(r.project) && needsDecision(r));
    if (open.length) return bad("Є відхилення без рішення: " + open.slice(0, 4).map((r) => r.name + " (" + r.project + ")").join(", ") + (open.length > 4 ? " і ще " + (open.length - 4) : "") + ".");
    mineSummary.forEach((s) => { d.conf.ok[s.project] = { by: me.name, at: nowISO(), fp: s.fp, people: s.people, warn: s.warn }; });
    await save();
    return reply();
  }

  if (b.action === "reopen") {
    const project = String(b.project || "");
    if (!mine.has(project)) return bad("Це не ваш проєкт.", 403);
    delete d.conf.ok[project];
    await save();
    return reply();
  }
  return bad("Невідома дія.");
}
