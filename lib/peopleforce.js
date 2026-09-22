// PeopleForce → довідник людей. PeopleForce головний для імені, email, посади,
// відділу, дивізіону і дат найму/звільнення. Розподіл по проєктах, команди й
// переведення живуть лише в застосунку і синхронізація їх не чіпає.
// Звільнених не видаляємо — позначаємо датою leftOn, щоб історія лишилась.
import { sameName } from "./users";

const BASE = (process.env.PEOPLEFORCE_URL || "https://app.peopleforce.io/api/public/v3").replace(/\/+$/, "");
export const pfConfigured = () => !!process.env.PEOPLEFORCE_API_KEY;

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const txt = (v, n = 160) => {
  const s = v == null ? "" : typeof v === "object" ? (v.name || v.title || v.full_name || "") : v;
  return String(s).trim().slice(0, n);
};
const day = (v) => (DATE_RE.test(String(v || "")) ? String(v).slice(0, 10) : "");
const low = (s) => String(s || "").trim().toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAll(path) {
  const out = [];
  for (let page = 1, pages = 1; page <= pages && page <= 200; page++) {
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(BASE + path + (path.includes("?") ? "&" : "?") + "page=" + page, {
        headers: { "X-API-KEY": process.env.PEOPLEFORCE_API_KEY, Accept: "application/json" },
        cache: "no-store",
      });
      if (res.status !== 429) break;
      await sleep(Math.min(10, Number(res.headers.get("retry-after")) || 2) * 1000);
    }
    if (res.status === 401 || res.status === 403) throw new Error("PeopleForce не прийняв ключ (" + res.status + "). Перевірте PEOPLEFORCE_API_KEY.");
    if (!res.ok) throw new Error("PeopleForce відповів " + res.status + " на " + path);
    const body = await res.json();
    out.push(...(Array.isArray(body.data) ? body.data : []));
    pages = Number(body.metadata && body.metadata.pages) || 1;
  }
  return out;
}

export function normalize(p, terminated) {
  const name = txt(p.full_name) || [txt(p.first_name), txt(p.last_name)].filter(Boolean).join(" ");
  const status = low(p.status);
  const leftOn = day(p.termination_effective_on) || (terminated || status === "terminated" || status === "dismissed" ? "today" : "");
  return {
    pfId: String(p.id), name, email: low(p.email).slice(0, 160), number: txt(p.employee_number, 60),
    position: txt(p.position), department: txt(p.department), division: txt(p.division),
    hiredOn: day(p.hired_on), leftOn,
  };
}

export async function pullPeopleForce() {
  const [active, gone] = await Promise.all([fetchAll("/employees"), fetchAll("/employees/terminated").catch(() => [])]);
  const byId = new Map();
  active.forEach((p) => byId.set(String(p.id), normalize(p, false)));
  // Звільнений запис перекриває активний: у ньому є дата звільнення.
  gone.forEach((p) => byId.set(String(p.id), { ...(byId.get(String(p.id)) || {}), ...normalize(p, true) }));
  return [...byId.values()].filter((x) => x.name);
}

const FIELDS = [["name", "ім'я"], ["email", "email"], ["position", "посада"], ["department", "відділ"], ["division", "дивізіон"], ["hiredOn", "дата найму"], ["leftOn", "звільнення"], ["pfId", ""], ["extId", ""]];

/* Чиста функція: застосовує список з PeopleForce до стану.
   Збіг шукаємо за ід PeopleForce, далі email, табельним номером, іменем. */
export function applyPeople(state, people, today, stamp) {
  const tomb = state.deleted || {};
  const employees = (state.employees || []).map((e) => ({ ...e }));
  const live = employees.filter((e) => !tomb["e:" + e.id]);
  const taken = new Set();
  const report = { added: [], updated: [], left: [], returned: [], skipped: 0 };
  const find = (p) => {
    const free = live.filter((e) => !taken.has(e.id));
    return free.find((e) => e.pfId && e.pfId === p.pfId)
      || (p.email && free.find((e) => !e.pfId && low(e.email) === p.email))
      || (p.number && free.find((e) => !e.pfId && e.extId && String(e.extId) === p.number))
      || free.find((e) => !e.pfId && sameName(e.name, p.name));
  };

  // Спершу активні, потім звільнені — щоб тезка-звільнений не «забрав» картку активного.
  const order = [...people].sort((a, b) => (a.leftOn ? 1 : 0) - (b.leftOn ? 1 : 0));
  for (const p of order) {
    const leftOn = p.leftOn === "today" ? today : p.leftOn;
    const e = find(p);
    if (!e) {
      if (leftOn && leftOn < today) { report.skipped++; continue; } // давно звільнених не додаємо
      const id = "e_pf" + p.pfId.replace(/[^\w-]/g, "");
      if (tomb["e:" + id]) { report.skipped++; continue; } // адміністратор прибрав цю людину — не повертаємо
      employees.push({
        id, name: p.name, email: p.email, position: p.position, department: p.department, division: p.division,
        hiredOn: p.hiredOn, leftOn: leftOn || "", pfId: p.pfId, extId: p.number, base: "Бенч", source: "peopleforce", updatedAt: stamp,
      });
      report.added.push(p.name);
      continue;
    }
    taken.add(e.id);
    const next = {
      name: p.name, email: p.email || e.email || "", position: p.position || e.position || "",
      department: p.department, division: p.division, hiredOn: p.hiredOn || e.hiredOn || "",
      leftOn: leftOn || "", pfId: p.pfId, extId: p.number || e.extId || "",
    };
    const changed = FIELDS.filter(([k]) => String(e[k] || "") !== String(next[k] || ""));
    if (!changed.length) continue;
    const i = employees.findIndex((x) => x.id === e.id);
    employees[i] = { ...e, ...next, updatedAt: stamp };
    if (next.leftOn && !e.leftOn) report.left.push(p.name + " — " + next.leftOn);
    else if (!next.leftOn && e.leftOn) report.returned.push(p.name);
    const visible = changed.filter(([k, l]) => l && k !== "leftOn").map(([k, l]) => l + ": " + (e[k] || "—") + " → " + (next[k] || "—"));
    if (visible.length) report.updated.push(p.name + " (" + visible.join("; ") + ")");
  }
  return { state: { ...state, employees }, report };
}
