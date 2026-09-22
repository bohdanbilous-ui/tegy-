import { NextResponse } from "next/server";
import { readState, writeState } from "../../../lib/store";
import { whoIs } from "../../../lib/auth";
import { sameName } from "../../../lib/users";
import { cleanHours, hoursToAlloc } from "../../../lib/hours";
import { orderProjects, isInactive } from "../../../lib/projects";

export const dynamic = "force-dynamic";

/* Робоче місце відповідального за відсотки. Сервер віддає лише ті команди,
де ім'я людини стоїть у полі «Відповідальний за %», і лише людей цих команд.
Решта стану (інші команди, переведення, журнал, довідники) сюди не потрапляє. */

const PERIOD_RE = /^\d{4}-\d{2}-H[12]$/;
const nowISO = () => new Date().toISOString();
const entryId = (key, empId) => "en_" + key + "_" + empId;
const total = (alloc) => (alloc || []).reduce((s, r) => s + (Number(r.percent) || 0), 0);

function sliceFor(state, me) {
  const tomb = state.deleted || {};
  const teams = (state.teams || []).filter((t) => !tomb["tm:" + t.id] && sameName(t.owner, me.name));
  const ids = new Set(teams.map((t) => t.id));
  const members = (state.employees || [])
    .filter((e) => ids.has(e.teamId) && !tomb["e:" + e.id])
    .map((e) => ({ id: e.id, name: e.name, position: e.position || "", teamId: e.teamId, leftOn: e.leftOn || "" }));
  const memberIds = new Set(members.map((m) => m.id));
  const entries = (state.entries || []).filter((x) => memberIds.has(x.employeeId));
  // Колонки табеля: проєкти з довідника в його порядку + ті, що вже є в записах команди.
  // Неактивні проєкти лишаються колонкою лише там, де в них уже є відсотки.
  const used = new Set();
  entries.forEach((x) => (x.alloc || []).forEach((r) => { if (r.project && r.percent > 0) used.add(r.project); }));
  const meta = state.projectMeta || {};
  const projects = orderProjects([...(state.projects || []).filter((p) => p && !tomb["p:" + p]), ...used], meta)
    .filter((p) => !isInactive(meta, p) || used.has(p));
  const codes = {};
  projects.forEach((p) => { if ((state.codes || {})[p]) codes[p] = state.codes[p]; });
  return {
    me: { name: me.name, username: me.username },
    teams: teams.map((t) => ({ id: t.id, name: t.name, owner: t.owner, submitted: t.submitted || {} })),
    members, entries, projects, codes, inactive: projects.filter((p) => isInactive(meta, p)),
  };
}

async function guardUser(request) {
  const me = await whoIs(request);
  if (me.error) return { res: NextResponse.json({ error: me.error }, { status: 401 }) };
  return { me };
}

export async function GET(request) {
  const g = await guardUser(request);
  if (g.res) return g.res;
  const state = (await readState()) || {};
  return NextResponse.json(sliceFor(state, g.me));
}

/* Тіло: { teamId, periodKey, rows: [{ employeeId, alloc: [{ project, percent }], hours?: [{ project, hours }] }], submit }
   Якщо рядок прийшов у годинах, відсотки рахує сервер — з годин. */
export async function PUT(request) {
  const g = await guardUser(request);
  if (g.res) return g.res;
  const me = g.me;

  let body;
  try { body = await request.json(); }
  catch (e) { return NextResponse.json({ error: "Некоректний запит." }, { status: 400 }); }

  const { teamId, periodKey } = body || {};
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (!PERIOD_RE.test(String(periodKey || ""))) return NextResponse.json({ error: "Некоректний період." }, { status: 400 });
  if (rows.length > 500) return NextResponse.json({ error: "Забагато рядків." }, { status: 400 });

  const state = (await readState()) || {};
  const team = (state.teams || []).find((t) => t.id === teamId && !(state.deleted || {})["tm:" + t.id]);
  if (!team) return NextResponse.json({ error: "Команду не знайдено." }, { status: 404 });
  if (!sameName(team.owner, me.name)) {
    return NextResponse.json({ error: "Відсотки команди «" + team.name + "» вносить " + (team.owner || "адміністратор") + "." }, { status: 403 });
  }
  if ((team.submitted || {})[periodKey]) {
    return NextResponse.json({ error: "Період уже подано. Відкрити його знову може адміністратор." }, { status: 409 });
  }

  const members = (state.employees || []).filter((e) => e.teamId === team.id && !(state.deleted || {})["e:" + e.id]);
  const memberIds = new Set(members.map((e) => e.id));

  const clean = [];
  for (const r of rows) {
    if (!memberIds.has(r?.employeeId)) {
      return NextResponse.json({ error: "Людина не належить до команди «" + team.name + "»." }, { status: 403 });
    }
    if (Array.isArray(r.hours) && r.hours.length) {
      const hours = cleanHours(r.hours);
      if (!hours) return NextResponse.json({ error: "Забагато годин: у періоді їх не може бути більше 744." }, { status: 400 });
      clean.push({ employeeId: r.employeeId, alloc: hoursToAlloc(hours), hours });
      continue;
    }
    const alloc = [];
    for (const a of Array.isArray(r.alloc) ? r.alloc : []) {
      const project = String(a?.project || "").trim().slice(0, 120);
      const percent = Number(a?.percent);
      if (!project || !Number.isFinite(percent)) continue;
      if (percent < 0 || percent > 100) return NextResponse.json({ error: "Відсоток має бути від 0 до 100." }, { status: 400 });
      if (percent > 0 && !alloc.some((x) => x.project === project)) alloc.push({ project, percent: Math.round(percent * 100) / 100 });
    }
    clean.push({ employeeId: r.employeeId, alloc });
  }

  const stamp = nowISO();
  const entries = [...(state.entries || [])];
  for (const r of clean) {
    const id = entryId(periodKey, r.employeeId);
    const next = { id, periodKey, employeeId: r.employeeId, alloc: r.alloc, ...(r.hours && r.hours.length ? { hours: r.hours } : {}), updatedAt: stamp, updatedBy: me.name };
    const i = entries.findIndex((x) => x.id === id);
    if (i === -1) entries.push(next); else entries[i] = next;
  }
  state.entries = entries;

  const log = (action, details) => {
    state.log = [{ id: "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: stamp, who: me.name, email: "", action, details },
      ...(state.log || [])].slice(0, 300);
  };

  if (body.submit) {
    const bad = members.filter((e) => {
      const x = entries.find((y) => y.id === entryId(periodKey, e.id));
      return Math.abs(total(x && x.alloc) - 100) > 0.01;
    });
    if (bad.length) {
      await writeState(state);
      return NextResponse.json({
        error: "Не подано: сума не 100% у " + bad.map((e) => e.name).slice(0, 5).join(", ") + (bad.length > 5 ? " та ще " + (bad.length - 5) : "") + ".",
        ...sliceFor(state, me),
      }, { status: 400 });
    }
    state.teams = (state.teams || []).map((t) => (t.id !== team.id ? t : {
      ...t, submitted: { ...(t.submitted || {}), [periodKey]: { by: me.name, at: stamp } }, updatedAt: stamp, updatedBy: me.name,
    }));
    log("подав період", team.name + " · " + periodKey);
  }

  state.updatedAt = stamp;
  state.updatedBy = me.name;
  await writeState(state);
  return NextResponse.json(sliceFor(state, me));
}
