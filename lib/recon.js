// Звірка PM: план за Allocate проти фактичних годин з трекерів (Redmine, ClickUp — через дашборд).
//
// Потік:
//   1. Адміністратор завантажує години за половину місяця (людина; проєкт; години) — тестове джерело,
//      потім його замінить дашборд.
//   2. PM бачить по своїх проєктах: план (% за розподілом, зважений за робочими днями), факт (години ÷ норма).
//      Відхилення понад допуск — «червоний» рядок: PM обирає дію й пише коментар.
//   3. Коли всі червоні рядки мають рішення, PM підтверджує звірку. Підтвердження — за проєктом
//      (будь-кого з PM проєкту), зі знімком цифр: якщо дані потім змінились, воно «застаріле».
//   4. Бухгалтер у відомості ЗП бачить, які проєкти підтверджені.
// Чисті функції: працюють на сервері й у тестах.

import { allocAt } from "./alloc";
import { periodRange, normHours } from "./loans";

export const HOURS_KEY = "transfers:recon:hours:v1"; // { [period]: { at, by, rows: [{ person, project, hours }] } }
export const CONF_KEY = "transfers:recon:confirm:v1"; // { [period]: { res: { "empId|project": {...} }, ok: { [project]: {...} } } }
export const CFG_KEY = "transfers:recon:cfg:v1"; // { tol, tolSmall, smallUpTo }
export const NOTRACK_KEY = "transfers:recon:notrack:v1"; // { teams: [teamId], employees: [employeeId] } - хто не веде облік годин
export const ALIAS_KEY = "transfers:recon:alias:v1"; // { [англійське ім'я з трекера, нижній регістр]: employeeId }
export const DEFAULT_CFG = { tol: 10, tolSmall: 5, smallUpTo: 20 };
export const ACTIONS = { plan: "План застарів", tracker: "Трекер заповнено неточно", manual: "Мої години" };

const low = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const r1 = (v) => Math.round(v * 10) / 10;

/* Відповідність імен: у Redmine і ClickUp люди записані англійською, в Allocate — українським ПІБ.
   Спершу шукаємо явну відповідність (таблиця aliases), потім збіг за повним ПІБ. */
export function personResolver(employees, aliases) {
  const byName = new Map((employees || []).map((e) => [low(e.name), e.id]));
  const ids = new Set((employees || []).map((e) => e.id));
  return (person) => {
    const k = low(person);
    const a = (aliases || {})[k];
    if (a && ids.has(a)) return a;
    return byName.get(k) || null;
  };
}

// Спрощена транслітерація (КМУ 2010) для підказок: «Петренко Іван» → «petrenko ivan».
const TR = { а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", "'": "", "ʼ": "", "’": "" };
const translit = (s) => low(s).split("").map((c) => (c in TR ? TR[c] : c)).join("");
const simplify = (t) => t.replace(/kh/g, "h").replace(/ph/g, "f").replace(/y/g, "i").replace(/j/g, "i").replace(/w/g, "v").replace(/c(?=[ei])/g, "s").replace(/c/g, "k").replace(/x/g, "ks").replace(/(.)\1+/g, "$1").replace(/[^a-z]/g, "");
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
const tokens = (s) => low(s).replace(/[.,]/g, " ").split(" ").filter(Boolean);
// Схожість двох імен без урахування порядку слів і регістру; 0..1. Токени порівнюємо після спрощення (Oleksandr≈Олександр, Yuriy≈Юрій).
export function nameScore(latin, ukr) {
  const a = tokens(latin).map((t) => simplify(/[а-яіїєґ]/.test(t) ? translit(t) : t)).filter(Boolean);
  const b = tokens(ukr).map((t) => simplify(translit(t))).filter(Boolean);
  if (!a.length || !b.length) return 0;
  let used = new Set(), total = 0;
  a.forEach((x) => {
    let best = 0, bi = -1;
    b.forEach((y, i) => { if (used.has(i)) return; const d = lev(x, y), sc = 1 - d / Math.max(x.length, y.length, 1); if (sc > best) { best = sc; bi = i; } });
    if (bi >= 0 && best >= 0.6) { used.add(bi); total += best; }
  });
  return total / Math.max(a.length, b.length);
}
export function suggestEmployee(person, employees) {
  let best = null;
  (employees || []).forEach((e) => { const sc = nameScore(person, e.name); if (sc >= 0.75 && (!best || sc > best.score)) best = { employeeId: e.id, name: e.name, score: r1(sc * 100) / 100 }; });
  return best;
}
export const rowKey = (empId, project) => empId + "|" + project;

export const cleanNoTrack = (v) => {
  const arr = (a) => [...new Set((Array.isArray(a) ? a : []).map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 500);
  return { teams: arr(v && v.teams), employees: arr(v && v.employees) };
};
export const cleanCfg = (c) => {
  const n = (v, d, max) => { if (v == null || v === "") return d; const x = Number(v); return Number.isFinite(x) && x >= 0 && x <= max ? x : d; };
  return { tol: n(c && c.tol, DEFAULT_CFG.tol, 100), tolSmall: n(c && c.tolSmall, DEFAULT_CFG.tolSmall, 100), smallUpTo: n(c && c.smallUpTo, DEFAULT_CFG.smallUpTo, 100) };
};

function workdays(from, to) {
  const out = [];
  for (const d = new Date(from + "T00:00:00Z"), end = new Date(to + "T00:00:00Z"); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// План людини за період: середній за робочими днями відсоток по проєктах (з урахуванням переведень).
// Якщо за період є запис у «Табелі команд» (його подає відповідальний команди — це основа тегів і для спільних команд), план беремо з нього.
export function planOf(emp, transfers, key, entry) {
  const fromEntry = {};
  ((entry && entry.alloc) || []).forEach((x) => { const v = Number(x.percent) || 0; if (x.project && v > 0) fromEntry[x.project] = (fromEntry[x.project] || 0) + v; });
  if (Object.keys(fromEntry).length) { Object.keys(fromEntry).forEach((p) => { fromEntry[p] = r1(fromEntry[p]); }); Object.defineProperty(fromEntry, "__src", { value: "entry", enumerable: false }); return fromEntry; }
  const { from, to } = periodRange(key);
  const days = workdays(from, to).filter((d) => (!emp.hiredOn || emp.hiredOn <= d) && (!emp.leftOn || emp.leftOn >= d));
  const out = {};
  if (!days.length) return out;
  const all = workdays(from, to).length;
  days.forEach((d) => allocAt(emp, transfers, d).forEach((x) => { if (x.percent > 0) out[x.project] = (out[x.project] || 0) + x.percent; }));
  Object.keys(out).forEach((p) => { out[p] = r1(out[p] / all); }); // ділимо на всі робочі дні періоду: неповний період дає менший план
  return out;
}

export const tolFor = (planPct, cfg) => (planPct <= cfg.smallUpTo ? cfg.tolSmall : cfg.tol);

/* Рядки звірки. projects — множина проєктів, які бачить користувач.
   hours — { rows: [{ person, project, hours }] } або null (годин немає).
   res — рішення PM: { "empId|project": { action, comment, hours } }. */
export function reconRows({ key, employees, transfers, projects, hours, res, cfg, entries, aliases, teams, pms, noTrack }) {
  const nt = cleanNoTrack(noTrack);
  const ntTeams = new Set(nt.teams), ntEmps = new Set(nt.employees);
  const teamName = new Map((teams || []).map((t) => [t.id, t.name]));
  const entryOf = new Map((entries || []).filter((x) => x.periodKey === key).map((x) => [x.employeeId, x]));
  const norm = normHours(key);
  const resolve = personResolver(employees, aliases);
  const byPerson = new Map();
  ((hours && hours.rows) || []).forEach((h) => {
    const k = resolve(h.person);
    if (!k) return;
    if (!byPerson.has(k)) byPerson.set(k, {});
    const m = byPerson.get(k);
    m[h.project] = (m[h.project] || 0) + (Number(h.hours) || 0);
  });
  const rows = [];
  (employees || []).forEach((e) => {
    const plan = planOf(e, transfers, key, entryOf.get(e.id));
    const planSrc = plan.__src === "entry" ? "entry" : "alloc";
    const fact = byPerson.get(e.id) || null;
    const names = new Set([...Object.keys(plan), ...(fact ? Object.keys(fact) : [])]);
    names.forEach((project) => {
      if (!projects.has(project)) return;
      const planPct = plan[project] || 0;
      const trackerHours = fact ? r1(fact[project] || 0) : null;
      const r = (res || {})[rowKey(e.id, project)] || null;
      const manual = r && r.action === "manual" && Number.isFinite(Number(r.hours)) ? Number(r.hours) : null;
      const factHours = manual != null ? manual : trackerHours;
      const noData = factHours == null;
      const factPct = noData ? null : r1((factHours / norm) * 100);
      const diff = noData ? null : r1(factPct - planPct);
      const tol = tolFor(planPct, cfg);
      let state = "ok";
      const untracked = noData && (ntEmps.has(e.id) || (e.teamId && ntTeams.has(e.teamId)));
      if (untracked) state = "notrack"; // не веде облік годин: розподіл збирає адміністратор вручну
      else if (noData) state = hours ? "nodata" : "nosource"; // є завантажені години, але людини в них немає / годин узагалі немає
      else if (Math.abs(diff) > tol) state = "warn";
      // Хто ця людина і куди ще розподілена — щоб PM і керівництво одразу розуміли, чи це «спільний» працівник (дизайн, маркетинг, розробник з іншого проєкту).
      const others = Object.keys(plan).filter((q) => q !== project).map((q) => ({ project: q, pct: plan[q], pm: (pms && pms[q]) || "" })).sort((a, b) => b.pct - a.pct);
      const shared = Object.keys(plan).length >= 2 || (fact ? Object.keys(fact).length >= 2 : false);
      rows.push({ employeeId: e.id, name: e.name, position: e.position || "", team: teamName.get(e.teamId) || "", shared, others, project, planPct, planSrc, trackerHours, factHours, factPct, diff, tol, state, res: r, norm });
    });
  });
  rows.sort((a, b) => a.project.localeCompare(b.project, "uk") || a.name.localeCompare(b.name, "uk"));
  return rows;
}

// Рядок потребує рішення PM, поки є відхилення чи немає даних, а рішення не обране.
export const needsDecision = (r) => (r.state === "warn" || r.state === "nodata") && !r.res;

// Відбиток цифр проєкту: після підтвердження будь-яка зміна плану чи факту робить підтвердження застарілим.
export function fingerprint(rows) {
  const str = rows.map((r) => [r.employeeId, r.project, r.planPct, r.factHours, r.res ? r.res.action : ""].join("|")).sort().join("\n");
  let h = 5381; for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return String(h);
}

// Розбір тексту «людина; проєкт; години» (роздільник ; , або табуляція).
export function parseHoursText(text) {
  const rows = [], bad = [];
  String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
    if (/^(людина|person|співробітник|піб)[\s;,\t]/i.test(line)) return; // заголовок
    const parts = line.split(/[;\t]|,(?=[^,]*,[^,]*$)/).map((s) => s.trim());
    if (parts.length < 3) { bad.push(i + 1); return; }
    const hours = Number(String(parts[parts.length - 1]).replace(",", "."));
    const person = parts[0], project = parts.slice(1, -1).join(" ").trim();
    if (!person || !project || !Number.isFinite(hours) || hours < 0 || hours > 744) { bad.push(i + 1); return; }
    rows.push({ person, project, hours });
  });
  return { rows, bad };
}

// Рядки годин, які неможливо віднести до жодного PM: людини немає в Allocate (інше написання імені, зовнішній виконавець)
// або проєкт з трекера не збігається з жодним проєктом Allocate. Їх бачать лише адміністратор і бухгалтер.
export function unmatchedHours({ hours, employees, projects, aliases }) {
  const resolve = personResolver(employees, aliases);
  const known = new Set(projects || []);
  const out = [];
  ((hours && hours.rows) || []).forEach((h) => {
    const noPerson = !resolve(h.person), noProject = !known.has(h.project);
    if (noPerson || noProject) out.push({ person: h.person, project: h.project, hours: Number(h.hours) || 0, why: noPerson && noProject ? "both" : noPerson ? "person" : "project", suggest: noPerson ? suggestEmployee(h.person, employees) : null });
  });
  return out;
}

// Текст відповідності «English Name; Український ПІБ» (по рядку). Повертає { map: { low(english): employeeId }, bad: [рядки] }.
export function parseAliasText(text, employees) {
  const byName = new Map((employees || []).map((e) => [low(e.name), e.id]));
  const map = {}, bad = [];
  String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line, i) => {
    const parts = line.split(/[;\t]/).map((x) => x.trim());
    const id = parts.length >= 2 ? byName.get(low(parts[1])) : null;
    if (!parts[0] || !id) { bad.push({ line: i + 1, text: line.slice(0, 60) }); return; }
    map[low(parts[0])] = id;
  });
  return { map, bad };
}

/* Імпорт користувачів з трекера (вивантаження ClickUp: ім'я, email, статус).
   За email збігаємо з email співробітника в Allocate (він приходить з PeopleForce) — це надійно;
   за повним ПІБ — теж надійно; схоже ім'я лише підказуємо, зберігає людина. */
export function matchTrackerUsers(users, employees) {
  const byEmail = new Map();
  (employees || []).forEach((e) => { const m = low(e.email); if (m && !byEmail.has(m)) byEmail.set(m, e); });
  const byName = new Map((employees || []).map((e) => [low(e.name), e]));
  const matched = [], suggested = [], none = [];
  const seen = new Set();
  (users || []).forEach((u) => {
    const person = String((u && u.name) || "").trim().slice(0, 120);
    if (!person || seen.has(low(person))) return;
    seen.add(low(person));
    const email = low(u.email).slice(0, 160);
    let e = email ? byEmail.get(email) : null, by = "email";
    if (!e) { e = byName.get(low(person)); by = "name"; }
    if (e) { matched.push({ person, email, employeeId: e.id, name: e.name, by, status: String(u.status || "") }); return; }
    const s = suggestEmployee(person, employees);
    if (s) suggested.push({ person, email, status: String(u.status || ""), suggest: s });
    else none.push({ person, email, status: String(u.status || "") });
  });
  return { matched, suggested, none };
}
