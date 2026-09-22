"use client";
import React, { useState, useEffect, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { mergeState, uniq } from "../lib/merge";
import { hoursToAlloc, hoursTotal, hoursText, hasHours, MAX_HOURS } from "../lib/hours";
import { api } from "../lib/api";
import { workingOn } from "../lib/people";
import { orderProjects, isInactive } from "../lib/projects";
import TeamDesk from "./TeamDesk";
import Reminders from "./Reminders";

/* Вхід через Google: NEXT_PUBLIC_GOOGLE_CLIENT_ID і NEXT_PUBLIC_ALLOWED_DOMAIN.
   Токен перевіряється на сервері (app/api/state/route.js). */
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";

/* Позначки часу правок вирівнюються за годинником сервера: якщо годинник
   комп'ютера відстає, свіжа правка інакше програла б злиттю. */
let clockSkew = 0;
const nowISO = () => new Date(Date.now() + clockSkew).toISOString();
const learnClock = (serverNow, sentAt) => { const t = Date.parse(serverNow || ""); if (t) clockSkew = Math.max(0, t - sentAt + 1); };

/* Ролі: admin — усе; hrd — переведення + табель своїх команд; owner — лише табель. */
const roleOf = (u) => (!u ? "" : u.role || (u.isAdmin ? "admin" : "owner"));
const deskUser = (u) => roleOf(u) === "admin" || roleOf(u) === "hrd";
const ROLE_LABEL = { admin: "адміністратор", hrd: "HRD", owner: "відповідальний" };
const ALLOWED_DOMAIN = process.env.NEXT_PUBLIC_ALLOWED_DOMAIN || "";

const C = {
  paper: "#E7ECF4", surface: "#FFFFFF", ink: "#141E38", ink2: "#37456A",
  muted: "#6F7B99", line: "#C2CDE1", lineSoft: "#DFE5F0",
  signal: "#0C7480", signalSoft: "#DBEFF0",
  plan: "#33489E", planSoft: "#E1E6F8",
  warn: "#8A5510", warnSoft: "#F8EBD6",
  stop: "#8A2E44", stopSoft: "#F6E2E7",
};
const SERIF = '"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif';
const SANS = 'ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
const MONTHS = ["Січень","Лютий","Березень","Квітень","Травень","Червень","Липень","Серпень","Вересень","Жовтень","Листопад","Грудень"];

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const todayISO = () => iso(new Date());
const fmt = (s) => (s ? s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4) : "—");
const fmtDT = (s) => { const d = new Date(s); return isNaN(d) ? "—" : fmt(iso(d)) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const shiftMonth = (n, day) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + n); d.setDate(day); return iso(d); };
const plusDays = (s, n) => { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return iso(d); };
const addMonths = (s, n) => { const d = new Date(s + "T00:00:00"); d.setMonth(d.getMonth() + n); return iso(d); };
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
const monthKey = (s) => s.slice(0, 7);
const monthLabel = (k) => MONTHS[+k.slice(5, 7) - 1] + " " + k.slice(0, 4);
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const round2 = (n) => String(Number(n.toFixed(2)));
const plural = (n, a, b, c) => { const m = n % 100; if (m > 10 && m < 20) return c; const k = n % 10; return k === 1 ? a : k > 1 && k < 5 ? b : c; };

const asAlloc = (v) => (typeof v === "string" ? [{ project: v, percent: 100 }] : (v || []).map((x) => ({ project: x.project, percent: Number(x.percent) || 0 })));
const allocText = (a) => (!a || !a.length ? "—" : asAlloc(a).map((x) => (x.percent === 100 ? x.project : x.project + " " + round2(x.percent) + "%")).join(" + "));
const allocMap = (a) => { const m = {}; asAlloc(a).forEach((x) => (m[x.project] = (m[x.project] || 0) + x.percent)); return m; };
const sameAlloc = (a, b) => {
  const ma = allocMap(a), mb = allocMap(b);
  return [...new Set([...Object.keys(ma), ...Object.keys(mb)])].every((k) => (ma[k] || 0) === (mb[k] || 0));
};

const SEED_PROJECTS = [];
const SEED_PARTNERS = [];
/* Коди продуктів для тегів. Прив'язка «проєкт → код» живе в довіднику проєктів,
   сам тег збирається з поточного розподілу: cbx-47,cbx_pos-13,grp-40. */
const CODES = ["cbx", "nvkl", "dd", "kz", "uz", "pl", "cbx_pos", "cbx_tax", "cbx_acq", "mrktpl", "edi", "grp", "evkc", "fpv"];
const CODE_HINTS = [
  [/checkbox\s*group|^mc\b/i, "grp"], [/group/i, "grp"],
  [/posbox\.?pl|\bpl\b|poland|польщ/i, "pl"],
  [/posbox|\bpos\b/i, "cbx_pos"], [/taxbox|\btax\b|подат/i, "cbx_tax"],
  [/acquir|еквайр|acq/i, "cbx_acq"], [/navkolo|навколо/i, "nvkl"],
  [/dubidoc|дубідок|\bdd\b/i, "dd"], [/edibox|\bedi\b/i, "edi"],
  [/market|mrkt|маркетплейс/i, "mrktpl"], [/казах|\bkz\b/i, "kz"],
  [/узбек|\buz\b/i, "uz"], [/evkc/i, "evkc"], [/fpv/i, "fpv"],
  [/checkbox|чекбокс/i, "cbx"],
];
const guessCode = (name) => (CODE_HINTS.find(([re]) => re.test(name)) || [])[1] || "";

/* Тег: код-відсоток через кому. Відсотки округлюються до цілих так,
   щоб у сумі лишалось рівно 100 — залишки віддаються найбільшим часткам. */
function tagParts(alloc, codes) {
  const rows = [];
  asAlloc(alloc).filter((x) => x.percent > 0).forEach((x) => {
    const code = (codes || {})[x.project] || "";
    const found = rows.find((r) => r.code === code && code);
    if (found) found.raw += x.percent;
    else rows.push({ code, project: x.project, raw: x.percent });
  });
  const sum = rows.reduce((a, r) => a + r.raw, 0) || 1;
  rows.forEach((r) => { const v = (r.raw * 100) / sum; r.pct = Math.floor(v); r.rest = v - r.pct; });
  let left = 100 - rows.reduce((a, r) => a + r.pct, 0);
  rows.slice().sort((a, b) => b.rest - a.rest).forEach((r) => { if (left > 0) { r.pct++; left--; } });
  return rows.filter((r) => r.pct > 0);
}
const tagOf = (alloc, codes) => tagParts(alloc, codes).map((r) => (r.code || "?") + "-" + r.pct).join(",");

/* Відсотки залученості подають двічі на місяць: 01–15 і 16–кінець.
   Кожен період фіксується окремо, тож історія лишається. */
const lastDay = (y, m) => new Date(y, m, 0).getDate();
const periodKey = (y, m, half) => y + "-" + pad(m) + "-H" + half;
const periodOf = (isoDate) => {
  const y = +isoDate.slice(0, 4), m = +isoDate.slice(5, 7), d = +isoDate.slice(8, 10);
  return { y, m, half: d <= 15 ? 1 : 2 };
};
const periodLabel = (p) => MONTHS[p.m - 1] + " " + p.y + ", " + (p.half === 1 ? "01–15" : "16–" + lastDay(p.y, p.m));
const periodStart = (p) => p.y + "-" + pad(p.m) + "-" + (p.half === 1 ? "01" : "16");
const shiftPeriod = (p, n) => {
  let idx = p.y * 24 + (p.m - 1) * 2 + (p.half - 1) + n;
  const y = Math.floor(idx / 24); idx -= y * 24;
  return { y, m: Math.floor(idx / 2) + 1, half: (idx % 2) + 1 };
};

/* Місяць для фін. обліку: дві половини зводяться пропорційно дням
   (01–15 — 15 днів, 16–кінець — решта). Результат округлюється до цілих так,
   щоб сума не змінилась. Якщо одну половину не заповнено, береться інша. */
const monthKeyOf = (y, m) => y + "-" + pad(m);
const finLabel = (fm) => MONTHS[fm.m - 1] + " " + fm.y;
const stepMonth = (fm, n) => { const i = fm.y * 12 + fm.m - 1 + n; return { y: Math.floor(i / 12), m: (i % 12) + 1 }; };
const num2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const allocSig = (a) => asAlloc(a).filter((r) => r.percent > 0).map((r) => r.project + ":" + num2(r.percent)).sort().join("|");
function mergeHalves(a1, a2, days) {
  const x1 = asAlloc(a1).filter((r) => r.percent > 0), x2 = asAlloc(a2).filter((r) => r.percent > 0);
  if (!x1.length && !x2.length) return [];
  const w1 = x1.length && x2.length ? 15 / days : x1.length ? 1 : 0;
  const raw = new Map();
  x1.forEach((r) => raw.set(r.project, (raw.get(r.project) || 0) + r.percent * w1));
  x2.forEach((r) => raw.set(r.project, (raw.get(r.project) || 0) + r.percent * (1 - w1)));
  const rows = [...raw].map(([project, v]) => ({ project, percent: Math.floor(v + 1e-9), rest: v - Math.floor(v + 1e-9) }));
  let left = Math.round([...raw.values()].reduce((s, v) => s + v, 0)) - rows.reduce((s, r) => s + r.percent, 0);
  rows.slice().sort((a, b) => b.rest - a.rest).forEach((r) => { if (left > 0) { r.percent++; left--; } });
  return rows.filter((r) => r.percent > 0).map(({ project, percent }) => ({ project, percent }));
}

const SEED_TEAMS = ["Внутрішня автоматизація", "Маркетинг", "Адмін блок", "People Partner", "Рекрутинг", "Партнершіп"]
  .map((name, i) => ({ id: "tm" + i, name, owner: "", alloc: [], updatedAt: "", updatedBy: "" }));

const SEED_REASONS = [
  "Ротація за запитом команди", "Запит співробітника", "Старт нового проєкту",
  "Завершення проєкту", "Підсилення команди", "Вихід з бенчу",
  "Часткова зайнятість на другому проєкті",
];
const SEED_EMPLOYEES = [];
const SEED_TRANSFERS = [];

function allocAt(emp, transfers, dateISO) {
  let a = asAlloc(emp.base);
  transfers
    .filter((t) => t.employeeId === emp.id && !t.cancelled && t.effectiveDate <= dateISO)
    .sort((x, y) => x.effectiveDate.localeCompare(y.effectiveDate) || x.createdAt.localeCompare(y.createdAt))
    .forEach((t) => { a = (!t.temporary || !t.returnDate || t.returnDate > dateISO) ? asAlloc(t.to) : asAlloc(t.from); });
  return a;
}
/* ─── погодження ──────────────────────────────────────────────────────────
   Переведення діє з дати незалежно від погодження — PM підтверджують уже
   доконане. Погодження збираються з проєктів, яких торкнулася зміна:
   хто віддає частку людини і хто її приймає. За замовчуванням обов'язкове
   слово того, хто віддає; «обидва» вмикається в налаштуваннях. */
function approvalsFor(from, to, pms) {
  const f = allocMap(from), t = allocMap(to);
  const out = [];
  [...new Set([...Object.keys(f), ...Object.keys(t)])].forEach((project) => {
    const d = (t[project] || 0) - (f[project] || 0);
    if (Math.abs(d) < 0.01) return;
    out.push({
      project, role: d < 0 ? "give" : "take", delta: Math.abs(d),
      pm: (pms || {})[project] || "", status: "pending", by: "", at: "", comment: "",
    });
  });
  return out.sort((a, b) => a.role.localeCompare(b.role));
}
const isRequired = (a, mode) => (mode === "both" ? true : a.role === "give");
function approvalState(t, mode) {
  const list = t.approvals || [];
  if (!list.length) return "none";
  if (list.some((a) => a.status === "rejected")) return "rejected";
  const req = list.filter((a) => isRequired(a, mode));
  if (!req.length) return "approved";
  if (req.every((a) => a.status === "approved")) return "approved";
  return "pending";
}
const APPROVAL = {
  none: { label: "Без погодження", fg: C.muted, bg: "#E6EAF2" },
  pending: { label: "Чекає на PM", fg: C.warn, bg: C.warnSoft },
  approved: { label: "Погоджено", fg: C.signal, bg: C.signalSoft },
  rejected: { label: "Заперечення", fg: C.stop, bg: C.stopSoft },
};

function statusOf(t, today) {
  if (t.cancelled) return "cancelled";
  if (t.effectiveDate > today) return "planned";
  if (t.temporary && t.returnDate && t.returnDate <= today) return "done";
  return "active";
}
const STATUS = {
  planned: { label: "Заплановано", fg: C.plan, bg: C.planSoft },
  active: { label: "Діє", fg: C.signal, bg: C.signalSoft },
  done: { label: "Повернувся", fg: C.muted, bg: "#E6EAF2" },
  cancelled: { label: "Скасовано", fg: C.stop, bg: C.stopSoft },
};

function TextCell({ value, onCommit, placeholder, aria }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input type="text" value={v} placeholder={placeholder} aria-label={aria}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setV(value); e.currentTarget.blur(); } }}
      onBlur={() => { const t = v.trim(); if (t && t !== value) onCommit(t); else setV(value); }}
      style={{ padding: "7px 9px" }} />
  );
}

/* ─── шаблон і заливка ─────────────────────────────────────────────────── */
const EMP_HEAD = ["Ідентифікатор", "Ім'я", "Прізвище", "Посада", "Проєкт", "%", "Проєкт 2", "%", "Проєкт 3", "%"];
const norm = (v) => String(v ?? "").trim();
const isExample = (s) => /^приклад/i.test(s);

const RE = {
  full: /піб|повне ім|full ?name|ім'?я та прізв|ім'?я і прізв|прізвище,? ?ім/i,
  first: /^ім'?я|first ?name|given/i,
  last: /прізв|last ?name|surname|family/i,
  extId: /ідентифікатор|табельн|employee ?id|^id$|код співроб|№ ?співроб/i,
  position: /посад|position|title|роль|grade/i,
  location: /локац|офіс|місто|компан|юрособ|location|office|city|entity|department|департамент|відділ/i,
  project: /проєкт|проект|project|продукт/i,
  percent: /%|відсот|percent|частк|ставк|fte|завантаж/i,
};

function buildTemplate(projects, partners) {
  const wb = XLSX.utils.book_new();
  const emp = XLSX.utils.aoa_to_sheet([EMP_HEAD,
    ["1001", "Олена", "Кравчук", "Frontend Engineer", projects[0] || "Nordic Bank", 50, projects[1] || "Helix CRM", 50, "", ""]]);
  emp["!cols"] = [{ wch: 16 }, { wch: 18 }, { wch: 20 }, { wch: 28 }, { wch: 24 }, { wch: 7 }, { wch: 24 }, { wch: 7 }, { wch: 24 }, { wch: 7 }];
  XLSX.utils.book_append_sheet(wb, emp, "Співробітники");
  const prj = XLSX.utils.aoa_to_sheet([["Назва проєкту"], ...projects.map((p) => [p])]);
  prj["!cols"] = [{ wch: 30 }];
  XLSX.utils.book_append_sheet(wb, prj, "Проєкти");
  const pps = XLSX.utils.aoa_to_sheet([["Ім'я та прізвище"], ...partners.map((p) => [p])]);
  pps["!cols"] = [{ wch: 30 }];
  XLSX.utils.book_append_sheet(wb, pps, "People Partners");
  XLSX.writeFile(wb, "shablon-spivrobitnykiv.xlsx");
}

/* Розбирає довільну вигрузку за назвами колонок у шапці. Ім'я може бути
   одним стовпчиком або парою «Ім'я» + «Прізвище». Якщо стовпчика з проєктом
   немає — повертає needProject, і людина сама обирає, з якої колонки брати
   проєкт (напр. «Локація») чи куди зарахувати всіх. */
function parseEmployeeRows(rows) {
  const warnings = [];
  if (!rows.length) return { list: [], warnings, head: [], candidates: [], needProject: true };

  let hi = rows.findIndex((r) => r.some((c) => RE.full.test(norm(c)) || RE.first.test(norm(c)) || RE.last.test(norm(c))));
  if (hi === -1) hi = 0;
  const head = rows[hi].map(norm);
  const find = (re) => head.findIndex((h) => re.test(h));

  const fullCol = find(RE.full);
  const firstCol = fullCol === -1 ? find(RE.first) : -1;
  const lastCol = fullCol === -1 ? find(RE.last) : -1;
  const extCol = find(RE.extId);
  const posCol = find(RE.position);
  const locCol = find(RE.location);
  const nameOfRow = (r) => (fullCol !== -1 ? norm(r[fullCol]) : [norm(r[firstCol]), norm(r[lastCol])].filter(Boolean).join(" "));

  const pairs = [];
  head.forEach((h, i) => {
    if (RE.project.test(h) && !RE.percent.test(h)) {
      pairs.push({ p: i, pct: head[i + 1] !== undefined && RE.percent.test(head[i + 1]) ? i + 1 : null });
    }
  });

  const used = new Set([fullCol, firstCol, lastCol, extCol, ...pairs.map((x) => x.p), ...pairs.map((x) => x.pct)].filter((i) => i >= 0));
  const body = rows.slice(hi + 1).filter((r) => { const n = nameOfRow(r); return n && !isExample(n); });
  const candidates = head
    .map((h, i) => ({ i, head: h || "Стовпчик " + (i + 1), sample: norm(body[0] && body[0][i]) }))
    .filter((c) => !used.has(c.i) && c.sample);

  const list = [], rescaled = [];
  body.forEach((r) => {
    const name = nameOfRow(r);
    let alloc = null;
    if (pairs.length) {
      alloc = pairs
        .map(({ p, pct }) => ({ project: norm(r[p]), percent: pct === null ? NaN : Number(String(r[pct]).replace(",", ".").replace("%", "")) }))
        .filter((x) => x.project);
      if (!alloc.length) alloc = null;
      else if (alloc.length === 1) alloc[0].percent = 100;
      else {
        alloc = alloc.map((x) => ({ ...x, percent: Number.isFinite(x.percent) && x.percent > 0 ? x.percent : 0 }));
        const sum = alloc.reduce((s, x) => s + x.percent, 0);
        if (sum === 0) { alloc = alloc.map((x) => ({ ...x, percent: Math.round(100 / alloc.length) })); rescaled.push(name); }
        else if (Math.abs(sum - 100) > 0.01) { alloc = alloc.map((x) => ({ ...x, percent: Number(((x.percent * 100) / sum).toFixed(2)) })); rescaled.push(name); }
        const fix = 100 - alloc.reduce((s, x) => s + x.percent, 0);
        if (Math.abs(fix) > 0.001) alloc[0].percent = Number((alloc[0].percent + fix).toFixed(2));
      }
    }
    const raw = {};
    candidates.forEach((c) => (raw[c.i] = norm(r[c.i])));
    list.push({
      name, alloc, raw,
      extId: extCol !== -1 ? norm(r[extCol]) : "",
      position: posCol !== -1 ? norm(r[posCol]) : "",
      location: locCol !== -1 ? norm(r[locCol]) : "",
    });
  });

  const needProject = !pairs.length;
  const withProject = list.filter((x) => x.alloc).length;
  if (!needProject && withProject < list.length) warnings.push((list.length - withProject) + " рядків без проєкту — їх зарахуємо на обраний нижче.");
  if (rescaled.length) warnings.push("Розподіл не давав 100%, вирівняли пропорційно: " + rescaled.slice(0, 4).join(", ") + (rescaled.length > 4 ? " та ще " + (rescaled.length - 4) : ""));
  const key = (x) => (x.extId || x.name).toLowerCase();
  const dupes = list.map(key).filter((n, i, a) => a.indexOf(n) !== i);
  if (dupes.length) warnings.push("У файлі є повтори — лишиться останній рядок: " + uniq(dupes).slice(0, 4).join(", "));
  if (fullCol === -1 && firstCol !== -1 && lastCol !== -1) warnings.push("Ім'я і прізвище склеєні з двох стовпчиків.");
  if (extCol !== -1) warnings.push("Знайдено ідентифікатори — прив'яжемо людей за ними, тож перейменування нікого не задублює.");
  return { list, warnings, head, candidates, needProject };
}

const parseSimpleList = (rows) => (!rows.length ? [] : uniq(rows.slice(1).map((r) => norm(r[0])).filter((v) => v && !isExample(v))));

/* ─── спільне сховище ─────────────────────────────────────────────────────
   Дані лежать у спільному сховищі застосунку: усі, хто його відкриє,
   бачать той самий журнал. Записи звіряються за id та часом останньої
   правки, видалене позначається «надгробком», щоб не воскресало
   під час злиття з чужою копією. ───────────────────────────────────────── */
function isExpired(token) {
  try { return decodeJwt(token).exp * 1000 < Date.now() + 60000; } catch (e) { return true; }
}
function decodeJwt(token) {
  const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(decodeURIComponent(atob(p).split("").map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join("")));
}

export default function TransferDesk() {
  const today = todayISO();
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("form");
  // Остання відкрита вкладка кожного розділу — щоб повертатися туди, де був.
  const lastTab = useRef({});
  useEffect(() => {
    const sec = { form: "moves", journal: "moves", approve: "moves", req: "moves", teams: "sheet", remind: "sheet", fin: "sheet", report: "sheet", snap: "snap", lists: "lists" }[tab];
    if (sec) lastTab.current[sec] = tab;
  }, [tab]);
  const [user, setUser] = useState(null);

  const [employees, setEmployees] = useState(SEED_EMPLOYEES);
  const [projects, setProjects] = useState(SEED_PROJECTS);
  const [partners, setPartners] = useState(SEED_PARTNERS);
  const [reasons, setReasons] = useState(SEED_REASONS);
  const [transfers, setTransfers] = useState(SEED_TRANSFERS);
  const [admins, setAdmins] = useState([]);
  const [log, setLog] = useState([]);
  const [pms, setPms] = useState({});
  const [codes, setCodes] = useState({});
  const [projectMeta, setProjectMeta] = useState({});
  const [teams, setTeams] = useState(SEED_TEAMS);
  const [entries, setEntries] = useState([]);
  const [period, setPeriod] = useState(periodOf(todayISO()));
  const [showHistory, setShowHistory] = useState(null);
  const [fin, setFin] = useState([]);
  const [finMonth, setFinMonth] = useState(() => { const d = todayISO(); return { y: +d.slice(0, 4), m: +d.slice(5, 7) }; });
  const [finTeam, setFinTeam] = useState("all");
  const [settings, setSettings] = useState({ approvalMode: "give" });
  const [deleted, setDeleted] = useState({});
  const [approveNote, setApproveNote] = useState({});
  const [requests, setRequests] = useState([]);
  const [formReady, setFormReady] = useState(true);
  const [fromRequest, setFromRequest] = useState(null);
  const [syncAt, setSyncAt] = useState(null);
  const [syncState, setSyncState] = useState("ok");
  const [persistent, setPersistent] = useState(true);
  const offline = false;
  const stateRef = useRef(null);
  const tokenRef = useRef("");
  const lastSync = useRef("");
  const adopt = useRef(false);
  const inFlight = useRef(false);
  const syncAgain = useRef(false);

  const [loginName, setLoginName] = useState("");
  const [loginPick, setLoginPick] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);
  const googleBtn = useRef(null);

  const [selectedId, setSelectedId] = useState("");
  const [cardId, setCardId] = useState(null);
  const [editId, setEditId] = useState(null);
  const [edit, setEdit] = useState(null);
  const [editErrors, setEditErrors] = useState([]);
  const [query, setQuery] = useState("");
  const [dist, setDist] = useState([{ project: "", percent: 100 }]);
  const [effectiveDate, setEffectiveDate] = useState(plusDays(todayISO(), 14));
  const [temporary, setTemporary] = useState(false);
  const [returnDate, setReturnDate] = useState("");
  const [reason, setReason] = useState("Ротація за запитом команди");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState([]);
  const [toast, setToast] = useState(null);

  const [statusFilter, setStatusFilter] = useState("all");
  const [journalQuery, setJournalQuery] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [snapDate, setSnapDate] = useState(todayISO());
  const [openMonth, setOpenMonth] = useState(null);
  const [year, setYear] = useState(today.slice(0, 4));

  const [newEmp, setNewEmp] = useState("");
  const [newEmpPosition, setNewEmpPosition] = useState("");
  const [newEmpProject, setNewEmpProject] = useState("");
  const [newProject, setNewProject] = useState("");
  const [newPartner, setNewPartner] = useState("");
  const [newReason, setNewReason] = useState("");
  const [newTeam, setNewTeam] = useState("");
  const [openMember, setOpenMember] = useState(null);
  const [addMember, setAddMember] = useState({});
  const [compact, setCompact] = useState({});
  const [units, setUnits] = useState({}); // команда → "pct" | "h"; порожньо — за даними періоду
  const [listNote, setListNote] = useState("");
  const [book, setBook] = useState("emp");
  const [empQuery, setEmpQuery] = useState("");
  const [empSort, setEmpSort] = useState({ key: "name", dir: "asc" });
  const [empShown, setEmpShown] = useState(60);
  const [showGone, setShowGone] = useState(false);
  const [pf, setPf] = useState(null);
  const [pfBusy, setPfBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState(null);
  const [importError, setImportError] = useState("");
  const fileRef = useRef(null);

  /* ── синхронізація з сервером ── */
  const snap = () => ({ employees, projects, partners, reasons, transfers, admins, log, deleted, pms, codes, projectMeta, teams, entries, fin, settings });
  stateRef.current = snap();

  function applyState(d) {
    setEmployees(d.employees || []);
    setProjects(d.projects || []);
    setPartners(d.partners || []);
    setReasons((d.reasons || []).length ? d.reasons : SEED_REASONS);
    setTransfers((d.transfers || []).map((t) => ({ ...t, from: asAlloc(t.from), to: asAlloc(t.to) })));
    setAdmins(d.admins || []);
    setLog(d.log || []);
    setDeleted(d.deleted || {});
    setPms(d.pms || {});
    setCodes(d.codes || {});
    setProjectMeta(d.projectMeta || {});
    setTeams((d.teams || []).length || d._view === "hrd" ? (d.teams || []) : SEED_TEAMS);
    setEntries(d.entries || []);
    setFin(d.fin || []);
    setSettings({ approvalMode: "give", ...(d.settings || {}) });
  }

  useEffect(() => {
    try {
      const saved = localStorage.getItem("transfers-user");
      if (saved) {
        const u = JSON.parse(saved);
        if (!u.token || !isExpired(u.token)) { setUser(u); tokenRef.current = u.token || ""; }
        else localStorage.removeItem("transfers-user");
      }
    } catch (e) { /* немає збереженого входу */ }
    setReady(true);
  }, []);

  function onApiError(e) {
    console.error(e);
    if (e && e.status === 401) { setLoginError("Сесія завершилась — увійдіть ще раз."); signOut(); return; }
    setSyncState("error");
    if (e && e.status === 403) setToast("Сервер відхилив правку: " + (e.message || "немає прав"));
  }

  useEffect(() => {
    if (!ready || !deskUser(user)) return;
    (async () => {
      try {
        const sentAt = Date.now();
        const remote = await api.get({ token: tokenRef.current, name: user.name });
        learnClock(remote._now, sentAt);
        setPersistent(remote._persistent !== false);
        adoptServer(remote);
        if ((remote.employees || []).length) setSelectedId(remote.employees[0].id);
        setSyncAt(new Date()); setSyncState("ok");
      } catch (e) { onApiError(e); }
    })();
  }, [ready, user]);

  /* Синхронізація. lastSync — знімок стану, який збігається з сервером.
     Після застосування відповіді сервера наступний рендер лише запам'ятовує
     новий знімок (adopt), а не шле його назад — інакше виходить нескінченний
     цикл PUT, і кожна відповідь перезаписує цифри, які людина саме вводить. */
  function adoptServer(d) { applyState(d); adopt.current = true; }

  async function syncNow(silent) {
    if (!deskUser(user)) return;
    if (inFlight.current) { syncAgain.current = true; return; }
    inFlight.current = true;
    const sent = JSON.stringify(stateRef.current);
    try {
      if (!silent) setSyncState("saving");
      const sentAt = Date.now();
      const merged = await api.put({ token: tokenRef.current, name: user.name }, stateRef.current);
      learnClock(merged._now, sentAt);
      if (JSON.stringify(stateRef.current) === sent) {
        adoptServer(merged);
      } else {
        // Поки йшов запит, людина щось змінила: її свіжіші правки лишаються,
        // чужі зміни з сервера підтягуються, і за мить відправляємо ще раз.
        applyState(mergeState(stateRef.current, merged));
        syncAgain.current = true;
      }
      setSyncAt(new Date()); setSyncState("ok");
    } catch (e) { onApiError(e); }
    finally {
      inFlight.current = false;
      if (syncAgain.current) { syncAgain.current = false; setTimeout(() => syncNow(true), 400); }
    }
  }

  useEffect(() => {
    if (!ready || !deskUser(user)) return;
    const cur = JSON.stringify(snap());
    if (adopt.current) { adopt.current = false; lastSync.current = cur; return; }
    if (cur === lastSync.current) return;
    const id = setTimeout(() => syncNow(false), 700);
    return () => clearTimeout(id);
  }, [employees, projects, partners, reasons, transfers, admins, log, deleted, pms, codes, projectMeta, teams, entries, fin, settings, ready, user]);

  useEffect(() => {
    if (!ready || !deskUser(user)) return;
    const id = setInterval(() => { if (!document.hidden) syncNow(true); }, 60000);
    return () => clearInterval(id);
  }, [ready, user]);

  // Заявки з Google Форми: при вході, щохвилини й при відкритті вкладки.
  useEffect(() => {
    if (!ready || roleOf(user) !== "admin") return;
    loadRequests();
    const id = setInterval(() => { if (!document.hidden) loadRequests(); }, 60000);
    return () => clearInterval(id);
  }, [ready, user]);
  useEffect(() => { if (tab === "req") loadRequests(); }, [tab]);
  useEffect(() => { if (tab === "lists" && book === "emp") loadPf(); }, [tab, book, user]);

  const tomb = (key) => setDeleted((d) => ({ ...d, [key]: nowISO() }));
  const untomb = (key) => setDeleted((d) => { const n = { ...d }; delete n[key]; return n; });

  useEffect(() => {
    if (!ready) return;
    try {
      if (user) localStorage.setItem("transfers-user", JSON.stringify(user));
      else localStorage.removeItem("transfers-user");
    } catch (e) { /* приватний режим браузера */ }
  }, [user, ready]);

  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 4500); return () => clearTimeout(id); }, [toast]);
  useEffect(() => { if (listNote) { const id = setTimeout(() => setListNote(""), 5000); return () => clearTimeout(id); } }, [listNote]);
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") setCardId(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* Google Identity Services — вмикається, коли заданий GOOGLE_CLIENT_ID */
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || user || !ready) return;
    const done = () => {
      if (!window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (res) => {
          try {
            const p = decodeJwt(res.credential);
            if (ALLOWED_DOMAIN && p.hd !== ALLOWED_DOMAIN) {
              setLoginError("Увійти можна лише з акаунта @" + ALLOWED_DOMAIN + ".");
              return;
            }
            signIn({ name: p.name || p.email, email: p.email || "", source: "google", token: res.credential, isAdmin: false });
          } catch (e) { setLoginError("Не вдалося розібрати відповідь Google."); }
        },
      });
      if (googleBtn.current) window.google.accounts.id.renderButton(googleBtn.current, { theme: "outline", size: "large", text: "signin_with", locale: "uk" });
      setGoogleReady(true);
    };
    if (window.google?.accounts?.id) { done(); return; }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true; s.onload = done;
    s.onerror = () => setLoginError("Скрипт Google не завантажився — перевірте домен у Cloud Console.");
    document.body.appendChild(s);
  }, [ready, user]);

  function pushLog(action, details) {
    setLog((p) => [{ id: uid("l"), at: new Date().toISOString(), who: user?.name || "—", email: user?.email || "", action, details }, ...p].slice(0, 300));
  }
  function signIn(u) {
    tokenRef.current = u.token || "";
    setUser({ ...u, signedInAt: new Date().toISOString() });
    setLoginError("");
  }
  function signOut() { tokenRef.current = ""; setUser(null); setLoginPick(""); setLoginName(""); lastSync.current = ""; adopt.current = false; }

  /* ─── права ─────────────────────────────────────────────────────────────
     Розмежування працює в інтерфейсі: воно захищає від випадкових правок
     чужих записів, але не від того, хто відкриє консоль браузера. Справжній
     захист дає бекенд, який перевіряє, хто робить запит. Хто адміністратор,
     а хто — відповідальний лише за свою команду, вирішується на сервері за
     обліковим записом (lib/users.js), а не тут. ─────────────────────────── */
  const role = roleOf(user);
  const isAdmin = role === "admin";
  const isHrd = role === "hrd";
  const allPMs = useMemo(() => uniq(Object.values(pms)), [pms]);
  const isPMof = (project) => !!user && (pms[project] || "").toLowerCase() === user.name.toLowerCase();
  const canDecide = (a) => isAdmin || isPMof(a.project);
  const owns = (t) => !!user && ((t.partnerEmail && user.email && t.partnerEmail === user.email)
    || (t.partner || "").toLowerCase() === user.name.toLowerCase());
  const canCancel = (t) => owns(t) || isAdmin;
  const canDelete = () => isAdmin;
  const denied = (what) => { setToast("Немає прав: " + what + ". Попросіть автора запису або адміністратора."); };

  const employee = employees.find((e) => e.id === selectedId) || employees.find((e) => workingOn(e, today)) || employees[0];
  const currentAlloc = employee ? allocAt(employee, transfers, today) : [];
  const nameOf = (t) => employees.find((e) => e.id === t.employeeId)?.name || t.employeeName || "—";
  const cardEmp = employees.find((e) => e.id === cardId);

  const allProjects = useMemo(() => {
    const s = new Set(projects);
    employees.forEach((e) => asAlloc(e.base).forEach((x) => x.project && s.add(x.project)));
    transfers.forEach((t) => [...asAlloc(t.from), ...asAlloc(t.to)].forEach((x) => x.project && s.add(x.project)));
    // Порядок — як у довіднику проєктів (його задає адміністратор стрілками).
    return orderProjects([...projects, ...Array.from(s).filter((p) => !projects.includes(p)).sort((a, b) => a.localeCompare(b, "uk"))], projectMeta);
  }, [projects, employees, transfers, projectMeta]);
  const offProject = (p) => isInactive(projectMeta, p);
  const activeProjects = allProjects.filter((p) => !offProject(p));

  const allReasons = useMemo(
    () => uniq([...reasons, ...transfers.map((t) => t.reason)]).sort((a, b) => a.localeCompare(b, "uk")),
    [reasons, transfers]
  );

  const bookRows = useMemo(() => {
    const q = empQuery.trim().toLowerCase();
    const val = (e) => empSort.key === "position" ? (e.position || "")
      : empSort.key === "project" ? allocText(allocAt(e, transfers, today)) : e.name;
    return employees
      .filter((e) => showGone || workingOn(e, today))
      .filter((e) => !q || (e.name + " " + (e.position || "") + " " + (e.department || "") + " " + (e.extId || "") + " " + allocText(allocAt(e, transfers, today))).toLowerCase().includes(q))
      .sort((a, b) => val(a).localeCompare(val(b), "uk") * (empSort.dir === "asc" ? 1 : -1));
  }, [employees, transfers, empQuery, empSort, today, showGone]);
  const goneCount = employees.filter((e) => !workingOn(e, today)).length;

  const roster = employees.filter((e) => {
    if (!workingOn(e, today)) return false; // звільнених не переводимо
    const q = query.trim().toLowerCase();
    return !q || (e.name + " " + (e.position || "") + " " + (e.extId || "") + " " + allocText(allocAt(e, transfers, today))).toLowerCase().includes(q);
  });
  const pending = useMemo(
    () => transfers.find((t) => employee && t.employeeId === employee.id && !t.cancelled && t.effectiveDate >= today),
    [transfers, employee, today]
  );

  const total = dist.reduce((s, r) => s + (Number(r.percent) || 0), 0);
  const setRow = (i, patch) => setDist((d) => d.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setDist((d) => {
    const n = d.length + 1, even = Math.floor(100 / n);
    const rows = [...d, { project: "", percent: 0 }].map((r) => ({ ...r, percent: even }));
    rows[0].percent = 100 - even * (n - 1);
    return rows;
  });
  const dropRow = (i) => setDist((d) => { const rows = d.filter((_, j) => j !== i); if (rows.length === 1) rows[0].percent = 100; return rows; });
  const evenOut = () => setDist((d) => { const even = Math.floor(100 / d.length); return d.map((r, i) => ({ ...r, percent: i === 0 ? 100 - even * (d.length - 1) : even })); });
  const resetDist = () => setDist([{ project: "", percent: 100 }]);

  function submit() {
    const e = [];
    const rows = dist.map((r) => ({ project: r.project.trim(), percent: Number(r.percent) || 0 })).filter((r) => r.project || r.percent);
    if (!employee) e.push("Оберіть співробітника у списку ліворуч.");
    if (rows.some((r) => !r.project)) e.push("У кожному рядку розподілу має бути проєкт.");
    if (rows.some((r) => r.percent <= 0)) e.push("Відсоток на кожному проєкті має бути більшим за нуль.");
    if (new Set(rows.map((r) => r.project)).size !== rows.length) e.push("Один проєкт повторюється двічі — об'єднайте рядки.");
    rows.filter((r) => offProject(r.project) && !currentAlloc.some((c) => c.project === r.project)).forEach((r) => e.push("Проєкт «" + r.project + "» неактивний — на нього вже не переводять."));
    if (total !== 100) e.push("Розподіл має давати рівно 100%, зараз " + round2(total) + "%.");
    if (rows.length && sameAlloc(rows, currentAlloc)) e.push("Новий розподіл збігається з поточним.");
    if (!effectiveDate) e.push("Вкажіть дату переведення.");
    if (temporary) {
      if (!returnDate) e.push("Для тимчасового переведення потрібна дата повернення.");
      else if (returnDate <= effectiveDate) e.push("Дата повернення має бути пізнішою за дату переведення.");
    }
    if (!reason.trim()) e.push("Вкажіть підставу.");
    setErrors(e);
    if (e.length) return;
    const newId = uid("t");
    setTransfers((p) => [{
      id: newId, employeeId: employee.id, employeeName: employee.name,
      ...(fromRequest ? { requestId: fromRequest.id, requestedBy: fromRequest.requester || fromRequest.email } : {}),
      from: currentAlloc, to: rows, effectiveDate,
      temporary, returnDate: temporary ? returnDate : "",
      reason: reason.trim(), note: note.trim(),
      approvals: approvalsFor(currentAlloc, rows, pms),
      partner: user.name, partnerEmail: user.email || "",
      createdAt: nowISO(), updatedAt: nowISO(), cancelled: false,
    }, ...p]);
    const r = reason.trim();
    if (!reasons.some((x) => x.toLowerCase() === r.toLowerCase())) {
      setReasons((p) => [...p, r]); untomb("r:" + r);
      pushLog("додав підставу", r);
    }
    pushLog("створив переведення", employee.name + ": " + allocText(currentAlloc) + " → " + allocText(rows) + " з " + fmt(effectiveDate));
    setToast(employee.name + ": " + allocText(rows) + " з " + fmt(effectiveDate));
    resetDist(); setNote("");
    if (fromRequest) { decideRequest(fromRequest, "done", newId); setFromRequest(null); }
  }

  /* ─── заявки з Google Форми ─────────────────────────────────────────── */
  async function callRequests(method, body) {
    const res = await fetch("/api/requests", {
      method, cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + tokenRef.current },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }
  async function loadRequests() {
    if (!user || roleOf(user) !== "admin") return;
    try { const d = await callRequests("GET"); setRequests(d.requests || []); setFormReady(d.formReady !== false); }
    catch (e) { /* заявки не критичні — спробуємо наступного разу */ }
  }
  async function callPf(method) {
    const res = await fetch("/api/peopleforce", { method, headers: { Authorization: "Bearer " + tokenRef.current }, cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.last) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }
  async function loadPf() {
    if (!user || roleOf(user) !== "admin") return;
    try { setPf(await callPf("GET")); } catch (e) { /* не критично */ }
  }
  async function syncPf() {
    setPfBusy(true);
    try {
      const d = await callPf("POST");
      setPf(d);
      if (d.last && d.last.ok) {
        const sentAt = Date.now();
        const remote = await api.get({ token: tokenRef.current, name: user.name });
        learnClock(remote._now, sentAt);
        adoptServer(remote);
        setToast("PeopleForce: нових " + d.last.counts.added + ", оновлено " + d.last.counts.updated + ", звільнено " + d.last.counts.left + ".");
      } else setToast("PeopleForce: " + ((d.last && d.last.error) || "не вдалося"));
    } catch (e) { setToast("PeopleForce: " + e.message); }
    finally { setPfBusy(false); }
  }
  async function decideRequest(r, status, transferId, comment) {
    try { const d = await callRequests("PATCH", { id: r.id, status, transferId: transferId || "", comment: comment || "" }); setRequests(d.requests || []); }
    catch (e) { setToast("Не вдалося оновити заявку: " + e.message); }
  }
  function takeRequest(r) {
    const emp = employees.find((e) => e.id === r.employeeId) || employees.find((e) => e.name.trim().toLowerCase() === r.employee.trim().toLowerCase());
    if (emp) setSelectedId(emp.id);
    setDist(r.alloc.map((x) => ({ project: x.project, percent: x.percent })));
    setEffectiveDate(r.effectiveDate);
    setTemporary(!!r.temporary);
    setReturnDate(r.returnDate || "");
    if (r.reason) setReason(r.reason);
    setNote([r.note, r.agreedWith ? "Погоджено з: " + r.agreedWith : "", "Заявка від " + (r.requester || r.email) + (r.email && r.requester ? " (" + r.email + ")" : "")].filter(Boolean).join(" · "));
    setErrors(emp ? [] : ["«" + r.employee + "» немає в довіднику — оберіть людину у списку ліворуч."]);
    setFromRequest(r);
    setTab("form");
  }
  function rejectRequest(r) {
    const why = window.prompt("Чому відхиляєте заявку щодо «" + r.employee + "»? (побачите лише ви)", "");
    if (why === null) return;
    decideRequest(r, "rejected", "", why);
  }
  const newRequests = requests.filter((r) => r.status === "new");
  function toggleCancel(t) {
    if (!canCancel(t)) return denied("скасувати чуже переведення");
    setTransfers((p) => p.map((x) => (x.id === t.id ? { ...x, cancelled: !x.cancelled, updatedAt: nowISO() } : x)));
    pushLog(t.cancelled ? "відновив переведення" : "скасував переведення", nameOf(t) + ", " + fmt(t.effectiveDate));
  }
  function removeTransfer(t) {
    if (!canDelete()) return denied("видалити запис назавжди — це може лише адміністратор");
    setTransfers((p) => p.filter((x) => x.id !== t.id));
    tomb("t:" + t.id);
    pushLog("видалив переведення", nameOf(t) + ", " + fmt(t.effectiveDate) + " → " + allocText(t.to));
  }

  function openEdit(t) {
    if (!canCancel(t)) return denied("редагувати чуже переведення");
    setEditId(t.id);
    setEditErrors([]);
    setEdit({
      dist: asAlloc(t.to).map((x) => ({ ...x })),
      effectiveDate: t.effectiveDate, temporary: !!t.temporary, returnDate: t.returnDate || "",
      reason: t.reason, note: t.note || "",
    });
  }
  const editTotal = edit ? edit.dist.reduce((s, r) => s + (Number(r.percent) || 0), 0) : 0;
  const setEditRow = (i, patch) => setEdit((d) => ({ ...d, dist: d.dist.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const addEditRow = () => setEdit((d) => {
    const n = d.dist.length + 1, even = Math.floor(100 / n);
    const rows = [...d.dist, { project: "", percent: 0 }].map((r) => ({ ...r, percent: even }));
    rows[0].percent = 100 - even * (n - 1);
    return { ...d, dist: rows };
  });
  const dropEditRow = (i) => setEdit((d) => {
    const rows = d.dist.filter((_, j) => j !== i);
    if (rows.length === 1) rows[0].percent = 100;
    return { ...d, dist: rows };
  });

  function saveEdit() {
    const t = transfers.find((x) => x.id === editId);
    if (!t || !edit) return;
    const rows = edit.dist.map((r) => ({ project: r.project.trim(), percent: Number(r.percent) || 0 })).filter((r) => r.project || r.percent);
    const e = [];
    if (rows.some((r) => !r.project)) e.push("У кожному рядку розподілу має бути проєкт.");
    if (rows.some((r) => r.percent <= 0)) e.push("Відсоток має бути більшим за нуль.");
    if (new Set(rows.map((r) => r.project)).size !== rows.length) e.push("Один проєкт повторюється двічі.");
    if (editTotal !== 100) e.push("Розподіл має давати рівно 100%, зараз " + round2(editTotal) + "%.");
    if (!edit.effectiveDate) e.push("Вкажіть дату переведення.");
    if (edit.temporary) {
      if (!edit.returnDate) e.push("Для тимчасового переведення потрібна дата повернення.");
      else if (edit.returnDate <= edit.effectiveDate) e.push("Дата повернення має бути пізнішою за дату переведення.");
    }
    if (!edit.reason.trim()) e.push("Вкажіть підставу.");
    setEditErrors(e);
    if (e.length) return;

    const changes = [];
    if (!sameAlloc(rows, t.to)) changes.push(allocText(t.to) + " → " + allocText(rows));
    if (edit.effectiveDate !== t.effectiveDate) changes.push("дата " + fmt(t.effectiveDate) + " → " + fmt(edit.effectiveDate));
    if (edit.temporary !== !!t.temporary || (edit.temporary && edit.returnDate !== t.returnDate))
      changes.push(edit.temporary ? "тимчасове до " + fmt(edit.returnDate) : "стало постійним");
    if (edit.reason.trim() !== t.reason) changes.push("підстава: " + edit.reason.trim());
    if (!changes.length) { setEditId(null); setEdit(null); return; }

    const keepApprovals = sameAlloc(rows, t.to);
    setTransfers((p) => p.map((x) => (x.id === t.id ? {
      ...x, to: rows, effectiveDate: edit.effectiveDate,
      approvals: keepApprovals ? (x.approvals || []) : approvalsFor(t.from, rows, pms),
      temporary: edit.temporary, returnDate: edit.temporary ? edit.returnDate : "",
      reason: edit.reason.trim(), note: edit.note.trim(),
      editedBy: user.name, editedAt: nowISO(), updatedAt: nowISO(),
    } : x)));
    const r = edit.reason.trim();
    if (!reasons.some((x) => x.toLowerCase() === r.toLowerCase())) { setReasons((pr) => [...pr, r]); untomb("r:" + r); }
    pushLog("змінив переведення", nameOf(t) + ": " + changes.join("; "));
    setToast("Запис оновлено: " + changes.join("; "));
    setEditId(null); setEdit(null);
  }

  // У табелі періоду — лише ті, хто ще працював на його початок.
  const teamMembers = (id) => employees.filter((e) => e.teamId === id && workingOn(e, periodStart(period)));
  const pKey = periodKey(period.y, period.m, period.half);
  const entryId = (empId, key) => "en_" + key + "_" + empId;
  const entryOf = (empId, key) => entries.find((x) => x.id === entryId(empId, key));
  const allocIn = (empId, key) => (entryOf(empId, key) || {}).alloc || [];
  const personAlloc = (e) => allocIn(e.id, pKey);
  const isSubmitted = (t, key) => !!((t.submitted || {})[key || pKey]);

  function setCell(empId, project, value) {
    const n = value === "" ? 0 : Number(value);
    if (!Number.isFinite(n)) return;
    const v = Math.max(0, Math.min(100, n));
    setEntries((p) => {
      const id = entryId(empId, pKey), old = p.find((x) => x.id === id);
      const rows = (old ? old.alloc : []).map((r) => (r.project === project ? { ...r, percent: v } : r)).filter((r) => r.percent > 0);
      if (v > 0 && !rows.some((r) => r.project === project)) rows.push({ project, percent: v });
      // Внесли відсотки — години рядка більше не діють.
      const next = { id, periodKey: pKey, employeeId: empId, alloc: rows, updatedAt: nowISO(), updatedBy: user ? user.name : "" };
      return old ? p.map((x) => (x.id === id ? next : x)) : [...p, next];
    });
  }
  function setHoursCell(empId, project, value) {
    const n = value === "" ? 0 : Number(value);
    if (!Number.isFinite(n)) return;
    const v = Math.max(0, Math.min(MAX_HOURS, n));
    setEntries((p) => {
      const id = entryId(empId, pKey), old = p.find((x) => x.id === id);
      // Нуль лишаємо, поки людина друкує (напр. «0.5»); порожня клітинка — проєкт прибирається.
      let hrs = (hasHours(old) ? old.hours : []).map((h) => (h.project === project ? { ...h, hours: v } : h));
      if (value === "") hrs = hrs.filter((h) => h.project !== project);
      else if (!hrs.some((h) => h.project === project)) hrs.push({ project, hours: v });
      const next = { id, periodKey: pKey, employeeId: empId, hours: hrs, alloc: hoursToAlloc(hrs), updatedAt: nowISO(), updatedBy: user ? user.name : "" };
      return old ? p.map((x) => (x.id === id ? next : x)) : [...p, next];
    });
  }
  const hoursIn = (empId, key) => { const x = entryOf(empId, key || pKey); return hasHours(x) ? x.hours : []; };
  const hoursValue = (empId, project) => { const h = hoursIn(empId).find((x) => x.project === project); return h ? h.hours : ""; };
  const unitOf = (t) => units[t.id] || (teamMembers(t.id).some((e) => hasHours(entryOf(e.id, pKey))) ? "h" : "pct");
  const cellValue = (empId, project) => {
    const r = allocIn(empId, pKey).find((x) => x.project === project);
    return r ? r.percent : "";
  };
  const rowTotal = (empId) => allocIn(empId, pKey).reduce((a, r) => a + (Number(r.percent) || 0), 0);
  const colTotal = (teamId, project) => teamMembers(teamId).reduce((a, e) => a + (Number(cellValue(e.id, project)) || 0), 0);
  const filledIn = (id) => teamMembers(id).filter((e) => rowTotal(e.id) > 0).length;

  /* Колонки табеля — це активні проєкти в порядку довідника.
     Нічого додавати руками не треба: з'явився проєкт — з'явилась колонка. */
  const orderedProjects = allProjects;

  function teamColumns(t) {
    const used = new Set();
    teamMembers(t.id).forEach((e) => entries.filter((x) => x.employeeId === e.id)
      .forEach((x) => (x.alloc || []).forEach((r) => r.percent > 0 && used.add(r.project))));
    const now = new Set();
    teamMembers(t.id).forEach((e) => allocIn(e.id, pKey).forEach((r) => r.percent > 0 && now.add(r.project)));
    // За замовчуванням — лише проєкти, де в команди вже були відсотки. Нова команда бачить усі активні.
    if ((compact[t.id] ?? true) && used.size) return uniq([...orderedProjects.filter((p) => used.has(p)), ...used]).filter((p) => !offProject(p) || now.has(p));
    // Неактивний проєкт лишається колонкою, лише якщо в цьому періоді на ньому вже є відсотки.
    return uniq([...orderedProjects.filter((p) => !offProject(p) || now.has(p)), ...used].filter((p) => !offProject(p) || now.has(p)));
  }

  function copyPrevPeriod(t) {
    if (!canEditTeam(t)) return denied("вносити відсотки команди «" + t.name + "»");
    if (isSubmitted(t)) return setToast("Період уже поданий — спершу відкрийте його.");
    const prev = periodKey(...(() => { const x = shiftPeriod(period, -1); return [x.y, x.m, x.half]; })());
    const add = [];
    teamMembers(t.id).forEach((e) => {
      const src = allocIn(e.id, prev);
      const srcH = hoursIn(e.id, prev);
      if (src.length && !rowTotal(e.id)) add.push({ id: entryId(e.id, pKey), periodKey: pKey, employeeId: e.id, alloc: src.map((r) => ({ ...r })),
        ...(srcH.length ? { hours: srcH.map((h) => ({ ...h })) } : {}), updatedAt: nowISO(), updatedBy: user ? user.name : "" });
    });
    if (!add.length) return setToast("Немає що переносити: попередній період порожній або цей уже заповнений.");
    setEntries((p) => [...p.filter((x) => !add.some((a) => a.id === x.id)), ...add]);
    pushLog("переніс розподіл з попереднього періоду", t.name + ", " + add.length + " " + plural(add.length, "людина", "людини", "людей"));
    setToast("Перенесли " + add.length + " " + plural(add.length, "рядок", "рядки", "рядків"));
  }
  function submitPeriod(t) {
    if (!canEditTeam(t)) return denied("подавати період команди «" + t.name + "»");
    const bad = teamMembers(t.id).filter((e) => rowTotal(e.id) !== 100);
    if (bad.length) return setToast("Не подамо: у " + bad.length + " " + plural(bad.length, "людини", "людей", "людей") + " сума не 100%.");
    editTeam(t.id, (x) => ({ ...x, submitted: { ...(x.submitted || {}), [pKey]: { by: user.name, at: nowISO() } } }));
    pushLog("подав період", t.name + " · " + periodLabel(period));
    setToast("Період подано: " + t.name + ", " + periodLabel(period));
  }
  function reopenPeriod(t) {
    if (!isAdmin) return denied("відкрити поданий період може лише адміністратор");
    editTeam(t.id, (x) => { const sub = { ...(x.submitted || {}) }; delete sub[pKey]; return { ...x, submitted: sub }; });
    pushLog("відкрив поданий період", t.name + " · " + periodLabel(period));
  }
  const canEditTeam = (t) => isAdmin || (t.owner || "").toLowerCase() === (user ? user.name.toLowerCase() : "—");
  const setEmp = (id, patch) => setEmployees((p) => p.map((e) => (e.id === id ? { ...e, ...patch, updatedAt: nowISO() } : e)));
  function joinTeam(empId, teamId) {
    setEmp(empId, { teamId, teamAlloc: [] });
    const e = employees.find((x) => x.id === empId), t = teams.find((x) => x.id === teamId);
    pushLog(teamId ? "додав до команди" : "прибрав з команди", (e ? e.name : empId) + (t ? " → " + t.name : ""));
  }

  const stampTeam = (t) => ({ ...t, updatedAt: nowISO(), updatedBy: user ? user.name : "" });
  const editTeam = (id, fn) => setTeams((p) => p.map((t) => (t.id === id ? stampTeam(fn(t)) : t)));
  function setTeamOwner(id, owner) {
    if (!isAdmin) return denied("призначати відповідального може лише адміністратор");
    editTeam(id, (t) => ({ ...t, owner }));
    pushLog("призначив відповідального за %", (teams.find((t) => t.id === id) || {}).name + " → " + owner);
  }
  function addTeam() {
    const n = newTeam.trim();
    if (!n) return setListNote("Впишіть назву команди.");
    if (teams.some((t) => t.name.toLowerCase() === n.toLowerCase())) return setListNote("Така команда вже є.");
    setTeams((p) => [...p, stampTeam({ id: uid("tm"), name: n, alloc: [] })]);
    setNewTeam(""); pushLog("додав команду", n);
  }
  function removeTeam(id) {
    if (!isAdmin) return denied("прибирати команди може лише адміністратор");
    const t = teams.find((x) => x.id === id);
    setTeams((p) => p.filter((x) => x.id !== id)); tomb("tm:" + id);
    pushLog("прибрав команду", t ? t.name : id);
  }
  function suggestCodes() {
    let n = 0;
    const next = { ...codes };
    allProjects.forEach((p) => { if (!next[p]) { const g = guessCode(p); if (g) { next[p] = g; n++; } } });
    setCodes(next);
    setListNote(n ? "Підставили коди для " + n + " проєктів — перевірте й виправте, де не вгадали." : "Нових збігів не знайшли, впишіть коди вручну.");
    if (n) pushLog("підставив коди проєктів", String(n));
  }
  async function copyTag(text) {
    try { await navigator.clipboard.writeText(text); setToast("Тег скопійовано: " + text); }
    catch (e) { setToast("Не вдалося скопіювати — виділіть тег і скопіюйте вручну."); }
  }
  const noCode = allProjects.filter((p) => !codes[p]);

  function decide(t, project, ok) {
    const a = (t.approvals || []).find((x) => x.project === project);
    if (!a) return;
    if (!canDecide(a)) return denied("погоджувати може PM проєкту «" + project + "» або адміністратор");
    const comment = (approveNote[t.id + ":" + project] || "").trim();
    if (!ok && !comment) { setToast("Для заперечення напишіть причину."); return; }
    setTransfers((p) => p.map((x) => (x.id !== t.id ? x : {
      ...x, updatedAt: nowISO(),
      approvals: (x.approvals || []).map((y) => (y.project !== project ? y : {
        ...y, status: ok ? "approved" : "rejected", by: user.name, at: nowISO(), comment,
      })),
    })));
    setApproveNote((n) => ({ ...n, [t.id + ":" + project]: "" }));
    pushLog(ok ? "погодив переведення" : "заперечив проти переведення",
      nameOf(t) + ", " + project + (comment ? " — " + comment : ""));
    setToast(ok ? "Погоджено: " + nameOf(t) + ", " + project : "Заперечення записано");
  }
  const myPending = transfers.filter((t) => !t.cancelled && (t.approvals || []).some((a) => a.status === "pending" && canDecide(a)));
  const awaiting = transfers.filter((t) => !t.cancelled && approvalState(t, settings.approvalMode) === "pending");
  const objected = transfers.filter((t) => !t.cancelled && approvalState(t, settings.approvalMode) === "rejected");

  const journal = transfers.filter((t) => {
    if (statusFilter !== "all" && statusFilter !== statusOf(t, today)) return false;
    const q = journalQuery.trim().toLowerCase();
    return !q || [nameOf(t), allocText(t.from), allocText(t.to), t.reason, t.note, t.partner].join(" ").toLowerCase().includes(q);
  });

  function downloadXlsx(name, sheets) {
    const wb = XLSX.utils.book_new();
    sheets.forEach((sh) => {
      const ws = XLSX.utils.aoa_to_sheet(sh.rows);
      if (sh.cols) ws["!cols"] = sh.cols.map((w) => ({ wch: w }));
      if (sh.freeze) ws["!views"] = [{ state: "frozen", ySplit: sh.freeze }];
      XLSX.utils.book_append_sheet(wb, ws, sh.name);
    });
    XLSX.writeFile(wb, name);
  }
  const exportJournal = () => downloadXlsx("perevedennya-" + today + ".xlsx", [{
    name: "Журнал", freeze: 1, cols: [24, 26, 30, 30, 14, 14, 14, 26, 24, 20, 16],
    rows: [
      ["Співробітник", "Посада", "Було", "Стало", "Дата переведення", "Повернення", "Статус", "Підстава", "Коментар", "People Partner", "Створено"],
      ...journal.map((t) => [nameOf(t), employees.find((e) => e.id === t.employeeId)?.position || "", allocText(t.from), allocText(t.to), fmt(t.effectiveDate),
        t.temporary ? fmt(t.returnDate) : "постійне", STATUS[statusOf(t, today)].label, t.reason, t.note, t.partner, fmtDT(t.createdAt)]),
    ],
  }]);

  /* ─── зріз на дату ──────────────────────────────────────────────────── */
  const snapshot = useMemo(() => {
    const byProject = {};
    employees.forEach((e) => {
      allocAt(e, transfers, snapDate).forEach((x) => {
        (byProject[x.project] = byProject[x.project] || []).push({ name: e.name, id: e.id, percent: x.percent });
      });
    });
    Object.values(byProject).forEach((l) => l.sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name, "uk")));
    const split = employees.filter((e) => allocAt(e, transfers, snapDate).length > 1).length;
    const between = transfers.filter((t) => !t.cancelled && ((t.effectiveDate > today && t.effectiveDate <= snapDate) || (t.effectiveDate <= today && t.effectiveDate > snapDate))).length;
    return { byProject, split, between, names: Object.keys(byProject).sort((a, b) => a.localeCompare(b, "uk")) };
  }, [employees, transfers, snapDate, today]);
  const fteIn = (list) => list.reduce((s, x) => s + x.percent / 100, 0);
  const exportSnapshot = () => downloadXlsx("zriz-" + snapDate + ".xlsx", [
    { name: "Зріз " + fmt(snapDate), freeze: 1, cols: [26, 26, 12],
      rows: [["Проєкт", "Співробітник", "Відсоток"],
        ...snapshot.names.flatMap((p) => snapshot.byProject[p].map((x) => [p, x.name, x.percent]))] },
    { name: "Підсумок", freeze: 1, cols: [26, 12, 12],
      rows: [["Проєкт", "Людей", "Ставок"],
        ...snapshot.names.map((p) => [p, snapshot.byProject[p].length, Number(fteIn(snapshot.byProject[p]).toFixed(2))])] },
  ]);

  /* ─── звіт ──────────────────────────────────────────────────────────── */
  const years = useMemo(() => {
    const s = new Set(transfers.map((t) => t.effectiveDate.slice(0, 4)));
    s.add(today.slice(0, 4));
    return Array.from(s).sort().reverse();
  }, [transfers, today]);

  const report = useMemo(() => {
    const live = transfers.filter((t) => !t.cancelled && t.effectiveDate.slice(0, 4) === year);
    const months = MONTHS.map((_, i) => {
      const key = year + "-" + pad(i + 1);
      const items = live.filter((t) => monthKey(t.effectiveDate) === key).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
      const byPP = {}; let splits = 0;
      items.forEach((t) => { const k = t.partner || "не вказано"; byPP[k] = (byPP[k] || 0) + 1; if (asAlloc(t.to).length > 1) splits++; });
      return { key, label: MONTHS[i], items, byPP, splits, count: items.length };
    });
    const moves = {}, heads = {}, ppTotals = {}, reasons = {};
    allProjects.forEach((p) => (moves[p] = { in: 0, out: 0 }));
    live.forEach((t) => {
      const f = allocMap(t.from), to = allocMap(t.to);
      new Set([...Object.keys(f), ...Object.keys(to)]).forEach((p) => {
        const d = (to[p] || 0) - (f[p] || 0);
        moves[p] = moves[p] || { in: 0, out: 0 };
        if (d > 0) moves[p].in += d / 100; else if (d < 0) moves[p].out += -d / 100;
      });
      const k = t.partner || "не вказано"; ppTotals[k] = (ppTotals[k] || 0) + 1;
      const r = t.reason || "не вказано"; reasons[r] = (reasons[r] || 0) + 1;
    });
    employees.forEach((e) => allocAt(e, transfers, today).forEach((x) => {
      heads[x.project] = heads[x.project] || { people: 0, fte: 0 };
      heads[x.project].people++; heads[x.project].fte += x.percent / 100;
    }));
    return { months, max: Math.max(1, ...months.map((m) => m.count)), total: live.length, moves, heads, ppTotals, reasons };
  }, [transfers, year, allProjects, employees, today]);

  const exportTags = () => downloadXlsx("tegy-" + pKey + ".xlsx", [
    { name: "Табель " + pKey, freeze: 1, cols: [26, 24, 24, 34, 40, 12, 40, 12],
      rows: [["Співробітник", "Посада", "Команда", "Розподіл", "Тег", "Разом, %", "Години", "Годин разом"],
        ...teams.flatMap((t) => teamMembers(t.id).map((e) => {
          const a = allocIn(e.id, pKey), h = hoursIn(e.id);
          return [e.name, e.position || "", t.name, a.length ? allocText(a) : "", tagOf(a, codes), rowTotal(e.id), hoursText(h), h.length ? hoursTotal(h) : ""];
        }))] },
    { name: "Історія", freeze: 1, cols: [22, 26, 24, 40, 12, 10, 22],
      rows: [["Період", "Співробітник", "Команда", "Тег", "Разом, %", "Годин", "Оновив"],
        ...entries.slice().sort((a, b) => b.periodKey.localeCompare(a.periodKey)).map((x) => {
          const e = employees.find((y) => y.id === x.employeeId) || {};
          const t = teams.find((y) => y.id === e.teamId) || {};
          return [x.periodKey, e.name || x.employeeId, t.name || "", tagOf(x.alloc, codes),
            (x.alloc || []).reduce((a2, r) => a2 + (Number(r.percent) || 0), 0), hasHours(x) ? hoursTotal(x.hours) : "", x.updatedBy || ""];
        })] },
    { name: "Команди", freeze: 1, cols: [28, 24, 16, 10, 24],
      rows: [["Команда", "Відповідальний", "Заповнено", "Людей", "Період подано"],
        ...teams.map((t) => { const sb = (t.submitted || {})[pKey];
          return [t.name, t.owner || "", filledIn(t.id), teamMembers(t.id).length, sb ? sb.by + ", " + fmtDT(sb.at) : "ні"]; })] },
    { name: "Коди", freeze: 1, cols: [30, 16],
      rows: [["Проєкт", "Код"], ...allProjects.map((p) => [p, codes[p] || ""])] },
  ]);

  /* ─── місяць для фін. обліку ────────────────────────────────────────── */
  const finKey = monthKeyOf(finMonth.y, finMonth.m);
  const finDays = lastDay(finMonth.y, finMonth.m);
  const finK1 = periodKey(finMonth.y, finMonth.m, 1), finK2 = periodKey(finMonth.y, finMonth.m, 2);
  const finClose = fin.find((x) => x.id === "fc_" + finKey);
  const finClosed = !!(finClose && finClose.closed);
  const teamNameOf = (id) => (teams.find((t) => t.id === id) || {}).name || "";
  const byTeamName = (a, b) => (a.team || "яяя").localeCompare(b.team || "яяя", "uk") || a.name.localeCompare(b.name, "uk");

  const finData = useMemo(() => {
    const filled = (id, k) => allocIn(id, k).some((r) => r.percent > 0);
    const people = employees.filter((e) => (e.teamId && teams.some((t) => t.id === e.teamId) && workingOn(e, finK1.slice(0, 7) + "-01")) || filled(e.id, finK1) || filled(e.id, finK2));
    const rows = people.map((e) => {
      const a1 = asAlloc(allocIn(e.id, finK1)).filter((r) => r.percent > 0), a2 = asAlloc(allocIn(e.id, finK2)).filter((r) => r.percent > 0);
      const calc = mergeHalves(a1, a2, finDays);
      const ov = fin.find((x) => x.id === "fo_" + finKey + "_" + e.id);
      const manual = !!(ov && ov.alloc);
      const alloc = manual ? asAlloc(ov.alloc).filter((r) => r.percent > 0) : calc;
      return {
        id: e.id, name: e.name, position: e.position || "", teamId: e.teamId || "", team: teamNameOf(e.teamId),
        t1: tagOf(a1, codes), t2: tagOf(a2, codes), calc, calcTag: tagOf(calc, codes),
        alloc, tag: tagOf(alloc, codes), total: num2(alloc.reduce((s, r) => s + r.percent, 0)),
        manual, note: (ov && ov.note) || "", by: manual ? ov.updatedBy || "" : "", at: manual ? ov.updatedAt || "" : "",
        miss: !a1.length && !a2.length ? "немає даних" : !a1.length ? "бракує 01–15" : !a2.length ? "бракує 16–" + finDays : "",
      };
    }).sort(byTeamName);
    const pending = teams.filter((t) => employees.some((e) => e.teamId === t.id && workingOn(e, finK1.slice(0, 7) + "-01")))
      .map((t) => ({ name: t.name, h1: !!(t.submitted || {})[finK1], h2: !!(t.submitted || {})[finK2] }));
    return { rows, pending };
  }, [employees, entries, teams, fin, codes, finKey]);

  // Закритий місяць показуємо зі збереженого знімка: цифри й теги не рухаються.
  const finRows = useMemo(() => {
    if (!finClosed) return finData.rows;
    const live = new Map(finData.rows.map((r) => [r.id, r]));
    return (finClose.rows || []).map((s) => {
      const l = live.get(s.e), e = employees.find((x) => x.id === s.e);
      const alloc = (s.a || []).map(([project, percent]) => ({ project, percent: Number(percent) || 0 }));
      const teamId = (e && e.teamId) || "";
      return {
        t1: "", t2: "", calc: [], calcTag: "", miss: "", ...(l || {}),
        id: s.e, name: (e && e.name) || s.name || s.e, position: (e && e.position) || "", teamId, team: teamNameOf(teamId),
        alloc, tag: s.t || tagOf(alloc, codes), total: num2(alloc.reduce((x, r) => x + r.percent, 0)),
        manual: !!s.m, by: s.b || "", at: "", note: s.n || "",
        drift: !!l && allocSig(s.m ? alloc : l.calc) !== allocSig(alloc),
      };
    }).sort(byTeamName);
  }, [finClosed, finClose, finData, employees, teams, codes]);
  const finShown = finRows.filter((r) => finTeam === "all" || r.teamId === finTeam);
  const finCols = (() => {
    const used = new Set();
    finShown.forEach((r) => [...r.alloc, ...(r.calc || [])].forEach((a) => a.percent > 0 && used.add(a.project)));
    return uniq([...orderedProjects.filter((p) => used.has(p)), ...used]);
  })();
  const finBad = finData.rows.filter((r) => r.alloc.length && Math.abs(r.total - 100) > 0.01);
  const finOpen = finData.pending.filter((t) => !t.h1 || !t.h2);
  const finDrift = finRows.filter((r) => r.drift).length;

  function setFinRecord(empId, patch) {
    if (!isAdmin) return denied("коригувати місяць для фін. обліку може лише адміністратор");
    if (finClosed) return setToast("Місяць закрито — спершу відкрийте його.");
    const id = "fo_" + finKey + "_" + empId;
    setFin((p) => {
      const old = p.find((x) => x.id === id) || { id, kind: "override", monthKey: finKey, employeeId: empId, alloc: null, note: "" };
      const next = { ...old, ...patch, updatedAt: nowISO(), updatedBy: user.name };
      return p.some((x) => x.id === id) ? p.map((x) => (x.id === id ? next : x)) : [...p, next];
    });
  }
  function setFinCell(row, project, value) {
    const n = value === "" ? 0 : Number(value);
    if (!Number.isFinite(n)) return;
    const v = Math.max(0, Math.min(100, n));
    const rows = row.alloc.map((r) => (r.project === project ? { ...r, percent: v } : r)).filter((r) => r.percent > 0);
    if (v > 0 && !rows.some((r) => r.project === project)) rows.push({ project, percent: v });
    // Повернули цифри до розрахунку — коригування знімається само.
    setFinRecord(row.id, { alloc: allocSig(rows) === allocSig(row.calc) ? null : rows });
  }
  function resetFin(row) {
    setFinRecord(row.id, { alloc: null });
    pushLog("скинув коригування місяця", row.name + " · " + finLabel(finMonth));
  }
  function closeMonth() {
    if (!isAdmin) return denied("закрити місяць може лише адміністратор");
    if (finBad.length) {
      return setToast("Не закриємо: сума не 100% у " + finBad.length + " " + plural(finBad.length, "людини", "людей", "людей") + " (" +
        finBad.slice(0, 3).map((r) => r.name).join(", ") + (finBad.length > 3 ? "…" : "") + ").");
    }
    const rows = finData.rows.filter((r) => r.alloc.length);
    if (!rows.length) return setToast("За " + finLabel(finMonth) + " ще немає жодних даних.");
    const empty = finData.rows.length - rows.length;
    const msg = "Закрити " + finLabel(finMonth) + " для фін. обліку? Цифри й теги зафіксуються для " + rows.length + " " + plural(rows.length, "людини", "людей", "людей") + "." +
      (finOpen.length ? "\n\nНе всі періоди подано: " + finOpen.map((t) => t.name).join(", ") + "." : "") +
      (empty ? "\n\nБез даних " + empty + " — у звіт не потраплять." : "");
    if (!window.confirm(msg)) return;
    const stamp = nowISO();
    const snapRows = rows.map((r) => ({
      e: r.id, name: r.name, a: r.alloc.map((x) => [x.project, x.percent]), t: r.tag,
      ...(r.manual ? { m: 1, b: r.by } : {}), ...(r.note ? { n: r.note } : {}),
    }));
    const rec = { id: "fc_" + finKey, kind: "close", monthKey: finKey, closed: true, by: user.name, at: stamp, rows: snapRows, updatedAt: stamp, updatedBy: user.name };
    setFin((p) => [...p.filter((x) => x.id !== rec.id), rec]);
    pushLog("закрив місяць для фін. обліку", finLabel(finMonth) + ", " + rows.length + " " + plural(rows.length, "людина", "людини", "людей"));
    setToast("Місяць закрито: " + finLabel(finMonth));
  }
  function reopenMonth() {
    if (!isAdmin) return denied("відкрити місяць може лише адміністратор");
    if (!window.confirm("Відкрити " + finLabel(finMonth) + " знову? Цифри знову рахуватимуться з табеля (ручні коригування збережуться).")) return;
    const stamp = nowISO();
    setFin((p) => p.map((x) => (x.id === "fc_" + finKey ? { ...x, closed: false, rows: [], reopenedBy: user.name, reopenedAt: stamp, updatedAt: stamp, updatedBy: user.name } : x)));
    pushLog("відкрив місяць для фін. обліку", finLabel(finMonth));
  }
  function exportFin() {
    const rows = finRows;
    const byProj = {};
    rows.forEach((r) => r.alloc.forEach((a) => {
      const p = (byProj[a.project] = byProj[a.project] || { fte: 0, people: 0 });
      p.fte += a.percent / 100; p.people++;
    }));
    const byCode = {};
    Object.entries(byProj).forEach(([p, v]) => { const k = codes[p] || "без коду"; byCode[k] = (byCode[k] || 0) + v.fte; });
    const h2 = "16–" + finDays;
    downloadXlsx("fin-oblik-" + finKey + ".xlsx", [
      { name: "Місяць " + finKey, freeze: 1, cols: [26, 24, 24, 30, 30, 44, 34, 34, 10, 14, 30, 20],
        rows: [["Співробітник", "Посада", "Команда", "01–15", h2, "Розподіл за місяць", "Тег за місяць", "Тег за розрахунком", "Разом, %", "Джерело", "Примітка", "Скоригував"],
          ...rows.map((r) => [r.name, r.position, r.team, r.t1, r.t2, r.alloc.length ? allocText(r.alloc) : "", r.tag, r.calcTag,
            r.total, r.manual ? "коригування" : r.miss || "розрахунок", r.note, r.manual ? r.by : ""])] },
      { name: "По проєктах", freeze: 1, cols: [30, 14, 12, 10],
        rows: [["Проєкт", "Код", "Ставок", "Людей"],
          ...Object.keys(byProj).sort((a, b) => a.localeCompare(b, "uk")).map((p) => [p, codes[p] || "", num2(byProj[p].fte), byProj[p].people])] },
      { name: "По кодах", freeze: 1, cols: [16, 12],
        rows: [["Код", "Ставок"], ...Object.entries(byCode).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, num2(v)])] },
      { name: "Коригування", freeze: 1, cols: [26, 24, 34, 34, 34, 20],
        rows: [["Співробітник", "Команда", "За розрахунком", "Після коригування", "Примітка", "Скоригував"],
          ...rows.filter((r) => r.manual).map((r) => [r.name, r.team, r.calcTag, r.tag, r.note, r.by])] },
      { name: "Статус", cols: [30, 18, 18],
        rows: [["Місяць", finLabel(finMonth)],
          ["Стан", finClosed ? "закрито · " + finClose.by + ", " + fmtDT(finClose.at) : "не закрито (чернетка)"],
          ["Як рахується", "01–15 × 15/" + finDays + " + " + h2 + " × " + (finDays - 15) + "/" + finDays + ", округлено до цілих"],
          [],
          ["Команда", "01–15 подано", h2 + " подано"],
          ...finData.pending.map((t) => [t.name, t.h1 ? "так" : "ні", t.h2 ? "так" : "ні"])] },
    ]);
  }

  function exportReport() {
    const num = (n) => Number(n.toFixed(2));
    const months = [["Місяць", "Переведень", "З розподілом на кілька проєктів", "People Partners"],
      ...report.months.map((m) => [m.label, m.count, m.splits, Object.entries(m.byPP).map(([k, v]) => k + " — " + v).join(", ")]),
      ["Разом", report.total, report.months.reduce((s, m) => s + m.splits, 0), ""]];
    const moves = [["Проєкт", "Прийшло, ставок", "Пішло, ставок", "Нетто", "Зараз людей", "Зараз ставок"],
      ...Object.keys(report.moves).sort((a, b) => a.localeCompare(b, "uk")).map((p) => {
        const m = report.moves[p], h = report.heads[p] || { people: 0, fte: 0 };
        return [p, num(m.in), num(m.out), num(m.in - m.out), h.people, num(h.fte)];
      })];
    const reasonRows = [["Підстава", "Переведень"], ...Object.entries(report.reasons).sort((a, b) => b[1] - a[1])];
    const ppRows = [["People Partner", "Переведень"], ...Object.entries(report.ppTotals).sort((a, b) => b[1] - a[1])];
    const detail = [["Дата", "Співробітник", "Було", "Стало", "Тип", "Повернення", "Підстава", "Коментар", "Подав", "Статус"],
      ...transfers.filter((t) => !t.cancelled && t.effectiveDate.slice(0, 4) === year)
        .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
        .map((t) => [fmt(t.effectiveDate), nameOf(t), allocText(t.from), allocText(t.to),
          t.temporary ? "тимчасове" : "постійне", t.temporary ? fmt(t.returnDate) : "", t.reason, t.note || "",
          t.partner, STATUS[statusOf(t, today)].label])];
    downloadXlsx("zvit-perevedennya-" + year + ".xlsx", [
      { name: "По місяцях", freeze: 1, cols: [14, 14, 28, 40], rows: months },
      { name: "Рух по проєктах", freeze: 1, cols: [26, 16, 14, 10, 14, 14], rows: moves },
      { name: "Підстави", freeze: 1, cols: [34, 14], rows: reasonRows },
      { name: "People Partners", freeze: 1, cols: [26, 14], rows: ppRows },
      { name: "Деталізація", freeze: 1, cols: [12, 24, 28, 28, 13, 13, 26, 24, 20, 14], rows: detail },
    ]);
  }

  /* ─── списки ────────────────────────────────────────────────────────── */
  const transfersOf = (id) => transfers.filter((t) => t.employeeId === id).length;
  const usesProject = (p) => transfers.filter((t) => allocMap(t.from)[p] || allocMap(t.to)[p]).length;
  const usesPartner = (p) => transfers.filter((t) => t.partner === p).length;
  const onProject = (p) => employees.filter((e) => allocMap(allocAt(e, transfers, today))[p]).length;
  const fteOn = (p) => employees.reduce((s, e) => s + (allocMap(allocAt(e, transfers, today))[p] || 0) / 100, 0);

  function addEmployee() {
    const n = newEmp.trim();
    if (!n) return setListNote("Впишіть ім'я співробітника.");
    if (employees.some((e) => e.name.toLowerCase() === n.toLowerCase())) return setListNote("Такий співробітник уже є у списку.");
    const pr = (newEmpProject || "").trim() || "Бенч";
    setEmployees((p) => [...p, { id: uid("e"), name: n, position: newEmpPosition.trim(), base: pr, updatedAt: nowISO() }]);
    if (!allProjects.includes(pr)) { setProjects((x) => [...x, pr]); untomb("p:" + pr); }
    setNewEmp(""); setNewEmpPosition("");
    setListNote(n + " доданий(а) на проєкт «" + pr + "».");
    pushLog("додав співробітника", n);
  }
  function renameEmployee(id, name) {
    if (employees.some((e) => e.id !== id && e.name.toLowerCase() === name.toLowerCase())) return setListNote("Ім'я «" + name + "» вже зайняте.");
    setEmployees((p) => p.map((e) => (e.id === id ? { ...e, name, updatedAt: nowISO() } : e)));
    setTransfers((p) => p.map((t) => (t.employeeId === id ? { ...t, employeeName: name, updatedAt: nowISO() } : t)));
  }
  function removeEmployee(id) {
    if (!isAdmin) return denied("прибирати людей зі списку може лише адміністратор");
    const e = employees.find((x) => x.id === id), n = transfersOf(id);
    setEmployees((p) => p.filter((x) => x.id !== id));
    tomb("e:" + id);
    if (selectedId === id) setSelectedId(employees.filter((x) => x.id !== id)[0]?.id || "");
    if (cardId === id) setCardId(null);
    setListNote(n ? "Співробітника прибрано зі списку. " + n + " записів лишились у журналі." : "Співробітника прибрано зі списку.");
    pushLog("прибрав співробітника", e?.name || id);
  }
  const renameIn = (a, oldName, name) => asAlloc(a).map((x) => (x.project === oldName ? { ...x, project: name } : x));
  function setPM(project, pm) {
    setPms((p) => ({ ...p, [project]: pm }));
    setTransfers((p) => p.map((t) => {
      const list = t.approvals || [];
      if (!list.some((a) => a.project === project && a.status === "pending")) return t;
      return { ...t, updatedAt: nowISO(), approvals: list.map((a) => (a.project === project && a.status === "pending" ? { ...a, pm } : a)) };
    }));
    pushLog("призначив PM", project + " → " + pm);
  }
  function moveProject(name, dir) {
    const list = [...orderedProjects];
    const i = list.indexOf(name), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    list[i] = list[j]; list[j] = name;
    const at = nowISO();
    // Записуємо порядок усім проєктам разом — так він однозначний.
    setProjectMeta((m) => { const n = { ...m }; list.forEach((p, k) => { n[p] = { ...(n[p] || {}), order: k, updatedAt: at }; }); return n; });
  }
  function toggleProjectActive(p) {
    if (!isAdmin) return denied("змінювати проєкти може лише адміністратор");
    const off = !offProject(p);
    if (off && onProject(p) > 0 && !window.confirm("На проєкті «" + p + "» зараз " + onProject(p) + " " + plural(onProject(p), "людина", "людини", "людей") + ". Позначити неактивним? Їх треба буде перевести: новий розподіл на цей проєкт уже не вибрати.")) return;
    setProjectMeta((m) => ({ ...m, [p]: { ...(m[p] || {}), inactive: off, updatedAt: nowISO() } }));
    pushLog(off ? "позначив проєкт неактивним" : "повернув проєкт в активні", p);
  }
  function setCode(project, code) {
    setCodes((c) => ({ ...c, [project]: code.trim().toLowerCase() }));
    pushLog("змінив код проєкту", project + " → " + code);
  }
  function renameProject(oldName, name) {
    if (allProjects.some((p) => p !== oldName && p.toLowerCase() === name.toLowerCase())) return setListNote("Проєкт «" + name + "» уже є.");
    setProjects((p) => p.map((x) => (x === oldName ? name : x)));
    tomb("p:" + oldName); untomb("p:" + name);
    setPms((m) => { const n = { ...m }; if (n[oldName]) { n[name] = n[oldName]; delete n[oldName]; } return n; });
    setCodes((m) => { const n = { ...m }; if (n[oldName]) { n[name] = n[oldName]; delete n[oldName]; } return n; });
    setProjectMeta((m) => { const at = nowISO(); const n = { ...m }; if (n[oldName]) { n[name] = { ...n[oldName], updatedAt: at }; n[oldName] = { ...n[oldName], order: undefined, updatedAt: at }; } return n; });
    setTeams((p) => p.map((t) => ({ ...t, alloc: (t.alloc || []).map((r) => (r.project === oldName ? { ...r, project: name } : r)) })));
    setTransfers((p) => p.map((t) => ({ ...t, approvals: (t.approvals || []).map((a) => (a.project === oldName ? { ...a, project: name } : a)) })));
    setEmployees((p) => p.map((e) => ({ ...e, updatedAt: nowISO(), base: typeof e.base === "string" ? (e.base === oldName ? name : e.base) : renameIn(e.base, oldName, name) })));
    setTransfers((p) => p.map((t) => ({ ...t, updatedAt: nowISO(), from: renameIn(t.from, oldName, name), to: renameIn(t.to, oldName, name) })));
    pushLog("перейменував проєкт", oldName + " → " + name);
  }
  function addProject() {
    const n = newProject.trim();
    if (!n) return setListNote("Впишіть назву проєкту.");
    if (allProjects.some((p) => p.toLowerCase() === n.toLowerCase())) return setListNote("Такий проєкт уже є.");
    setProjects((p) => [...p, n]); untomb("p:" + n); setNewProject(""); setListNote("Проєкт «" + n + "» додано."); pushLog("додав проєкт", n);
  }
  function removeProject(p) {
    if (!isAdmin) return denied("прибирати проєкти може лише адміністратор");
    if (onProject(p) > 0) return setListNote("На проєкті «" + p + "» ще є люди. Спершу переведіть їх.");
    setProjects((x) => x.filter((v) => v !== p)); tomb("p:" + p);
    setListNote(usesProject(p) ? "Проєкт прибрано зі списку, в історії переведень він лишився." : "Проєкт прибрано.");
    pushLog("прибрав проєкт", p);
  }
  function renamePartner(oldName, name) {
    if (partners.some((p) => p !== oldName && p.toLowerCase() === name.toLowerCase())) return setListNote("Такий People Partner уже є.");
    setPartners((p) => p.map((x) => (x === oldName ? name : x)));
    tomb("pp:" + oldName); untomb("pp:" + name);
    setTransfers((p) => p.map((t) => (t.partner === oldName ? { ...t, partner: name, updatedAt: nowISO() } : t)));
    setAdmins((p) => p.map((x) => (x === oldName ? name : x)));
    if (user?.name === oldName) setUser((u) => ({ ...u, name }));
  }
  function addPartner() {
    const n = newPartner.trim();
    if (!n) return setListNote("Впишіть ім'я People Partner.");
    if (partners.some((p) => p.toLowerCase() === n.toLowerCase())) return setListNote("Такий People Partner уже є.");
    setPartners((p) => [...p, n]); untomb("pp:" + n); setNewPartner(""); setListNote(n + " доданий(а) до тих, хто подає переведення.");
  }
  function removePartner(p) {
    if (!isAdmin) return denied("прибирати People Partners може лише адміністратор");
    if (partners.length === 1) return setListNote("Має лишитись хоча б один People Partner.");
    setPartners((x) => x.filter((v) => v !== p)); tomb("pp:" + p);
    setListNote(usesPartner(p) ? "Прибрано зі списку, в історії переведень ім'я лишилось." : "Прибрано зі списку.");
  }

  const usesReason = (r) => transfers.filter((t) => t.reason === r).length;
  function renameReason(oldName, name) {
    if (allReasons.some((x) => x !== oldName && x.toLowerCase() === name.toLowerCase())) return setListNote("Така підстава вже є.");
    setReasons((p) => p.map((x) => (x === oldName ? name : x)));
    tomb("r:" + oldName); untomb("r:" + name);
    setTransfers((p) => p.map((t) => (t.reason === oldName ? { ...t, reason: name, updatedAt: nowISO() } : t)));
    if (reason === oldName) setReason(name);
    pushLog("перейменував підставу", oldName + " → " + name);
  }
  function addReason() {
    const n = newReason.trim();
    if (!n) return setListNote("Впишіть підставу.");
    if (allReasons.some((x) => x.toLowerCase() === n.toLowerCase())) return setListNote("Така підстава вже є.");
    setReasons((p) => [...p, n]); untomb("r:" + n); setNewReason(""); setListNote("Підставу «" + n + "» додано.");
    pushLog("додав підставу", n);
  }
  function removeReason(r) {
    if (!isAdmin) return denied("прибирати підстави може лише адміністратор");
    if (reasons.length === 1) return setListNote("Має лишитись хоча б одна підстава.");
    setReasons((p) => p.filter((x) => x !== r)); tomb("r:" + r);
    setListNote(usesReason(r) ? "Підставу прибрано зі списку, у старих записах вона лишилась." : "Підставу прибрано.");
    pushLog("прибрав підставу", r);
  }

  async function handleFile(file) {
    setImportError(""); setPreview(null);
    try {
      const isCsv = /\.csv$/i.test(file.name);
      const wb = isCsv ? XLSX.read(await file.text(), { type: "string" }) : XLSX.read(await file.arrayBuffer(), { type: "array" });
      const pick = (keys) => wb.SheetNames.find((n) => keys.some((k) => n.toLowerCase().includes(k)));
      const rowsOf = (n) => (n ? XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false, defval: "" }) : []);
      const parsed = parseEmployeeRows(rowsOf(pick(["співроб", "spivrob", "employee", "люди"]) || wb.SheetNames[0]));
      if (!parsed.list.length) return setImportError("У файлі не знайшли жодного співробітника. Потрібен стовпчик з іменем — «Ім'я та прізвище» або пара «Ім'я» + «Прізвище».");
      setPreview({
        fileName: file.name, ...parsed,
        projectCol: (() => {
          const c = parsed.candidates.find((x) => RE.location.test(x.head)) || parsed.candidates[0];
          return c ? String(c.i) : "";
        })(),
        fallback: allProjects.includes("Бенч") ? "Бенч" : (allProjects[0] || "Бенч"),
        projects: parseSimpleList(rowsOf(pick(["проєкт", "проект", "project"]))),
        partners: parseSimpleList(rowsOf(pick(["partner", "партнер"]))),
      });
    } catch (err) {
      setImportError("Не вдалося прочитати файл: " + (err?.message || "невідомий формат") + ". Приймаються .xlsx і .csv.");
    }
  }
  const resolveImport = (p) => p.list.map((x) => {
    if (x.alloc) return { ...x, alloc: x.alloc };
    const fromCol = p.projectCol !== "" ? norm(x.raw[p.projectCol]) : "";
    return { ...x, alloc: [{ project: fromCol || p.fallback || "Бенч", percent: 100 }] };
  });

  function applyImport(mode) {
    if (!preview) return;
    if (mode === "replace" && !isAdmin) return denied("замінити весь список може лише адміністратор");
    const byName = new Map(employees.map((e) => [e.name.toLowerCase(), e]));
    const byExt = new Map(employees.filter((e) => e.extId).map((e) => [String(e.extId), e]));
    let added = 0;
    const incoming = resolveImport(preview).map((x) => {
      const old = (x.extId && byExt.get(String(x.extId))) || byName.get(x.name.toLowerCase());
      if (!old) added++;
      return {
        id: old ? old.id : uid("e"), name: x.name, base: x.alloc, updatedAt: nowISO(),
        extId: x.extId || (old && old.extId) || "",
        position: x.position || (old && old.position) || "",
        location: x.location || (old && old.location) || "",
      };
    });
    const seen = new Map();
    incoming.forEach((e) => seen.set(e.name.toLowerCase(), e));
    const merged = mode === "replace" ? Array.from(seen.values())
      : [...employees.filter((e) => !seen.has(e.name.toLowerCase())), ...Array.from(seen.values())];
    const used = incoming.flatMap((e) => asAlloc(e.base).map((x) => x.project));
    setProjects(uniq(mode === "replace" ? [...preview.projects, ...used] : [...projects, ...preview.projects, ...used]));
    if (preview.partners.length) setPartners(uniq(mode === "replace" ? preview.partners : [...partners, ...preview.partners]));
    setEmployees(merged);
    if (!merged.some((e) => e.id === selectedId)) setSelectedId(merged[0]?.id || "");
    const gone = mode === "replace" ? employees.filter((e) => !seen.has(e.name.toLowerCase())) : [];
    gone.forEach((e) => tomb("e:" + e.id));
    const dropped = gone.length;
    setPreview(null);
    const msg = "Завантажено " + incoming.length + ": " + added + " нових, " + (incoming.length - added) + " оновлено" + (dropped ? ", " + dropped + " прибрано" : "") + ".";
    setListNote(msg); pushLog("залив список із файлу", preview.fileName + " — " + msg);
  }

  const counts = {
    planned: transfers.filter((t) => statusOf(t, today) === "planned").length,
    month: transfers.filter((t) => !t.cancelled && monthKey(t.effectiveDate) === monthKey(today)).length,
    split: employees.filter((e) => allocAt(e, transfers, today).length > 1).length,
  };

  const css = `
    .td *, .td *::before, .td *::after { box-sizing: border-box; }
    .td button, .td input, .td select { font: inherit; color: inherit; }
    .td :focus-visible { outline: 2px solid ${C.signal}; outline-offset: 2px; border-radius: 2px; }
    .td input[type="text"], .td input[type="date"], .td input[type="number"], .td select {
      width: 100%; background: ${C.surface}; border: 1px solid ${C.line};
      border-radius: 3px; padding: 9px 10px; color: ${C.ink};
    }
    .td .route { display: grid; grid-template-columns: 1fr 132px 1fr; align-items: start; }
    .td .spine { position: relative; display: grid; place-items: center; align-self: stretch; }
    .td .spine::before { content: ""; position: absolute; left: 50%; top: -18px; bottom: -18px; border-left: 1px dashed ${C.line}; }
    .td .rosterItem:hover { background: #F3F6FB; }
    .td table { border-collapse: collapse; width: 100%; }
    .td th, .td td { text-align: left; padding: 10px 12px; vertical-align: middle; }
    .td th { font-size: 12px; font-weight: 600; color: ${C.muted}; border-bottom: 1px solid ${C.line}; }
    .td td { border-bottom: 1px solid ${C.lineSoft}; font-size: 13.5px; }
    .td tbody tr:hover td { background: #F5F8FC; }
    .td .num { font-variant-numeric: tabular-nums; }
    .td .del { cursor: pointer; background: none; border: none; color: ${C.muted}; padding: 4px 6px; border-radius: 3px; }
    .td .del:hover { color: ${C.stop}; background: ${C.stopSoft}; }
    .td .ghost { cursor: pointer; background: none; border: 1px dashed ${C.line}; border-radius: 3px; padding: 8px 12px; color: ${C.ink2}; }
    .td .ghost:hover { border-color: ${C.signal}; color: ${C.signal}; }
    .td .link { cursor: pointer; background: none; border: none; padding: 0; color: ${C.signal}; text-decoration: underline; }
    @media (max-width: 900px) {
      .td .cols { grid-template-columns: 1fr !important; }
      .td .route { grid-template-columns: 1fr; }
      .td .spine { height: 30px; }
      .td .spine::before { left: 22px; top: 0; bottom: 0; }
    }
    @media (prefers-reduced-motion: reduce) { .td * { transition: none !important; animation: none !important; } }
  `;
  const label = { fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 6, display: "block" };
  const card = { background: C.surface, border: "1px solid " + C.line, borderRadius: 4 };
  const chip = (on) => ({ cursor: "pointer", padding: "6px 12px", borderRadius: 3, fontSize: 13,
    border: "1px solid " + (on ? C.ink2 : C.line), background: on ? C.ink : C.surface, color: on ? "#fff" : C.ink2 });
  const addBtn = { cursor: "pointer", background: C.ink, color: "#fff", border: "none", borderRadius: 3, padding: "9px 16px", whiteSpace: "nowrap" };

  if (!ready) {
    return <div style={{ background: C.paper, minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: SANS, color: C.muted }}>Завантажуємо журнал переведень…</div>;
  }

  /* ─── ВХІД ──────────────────────────────────────────────────────────── */
  if (!user) {
    return (
      <div className="td" style={{ background: C.paper, minHeight: "100vh", fontFamily: SANS, color: C.ink, fontSize: 14, display: "grid", placeItems: "center", padding: 24 }}>
        <style>{css}</style>
        <div style={{ ...card, padding: 28, width: "100%", maxWidth: 420 }}>
          <h1 style={{ margin: 0, fontFamily: SERIF, fontSize: 24, fontWeight: 600 }}>Переведення між проєктами</h1>
          <p style={{ color: C.ink2, marginTop: 8 }}>Увійдіть під своїм обліковим записом.</p>

          <div style={{ marginTop: 20 }}>
            <label style={label} htmlFor="username">Логін</label>
            <input id="username" type="text" autoComplete="username" value={loginName}
              onChange={(e) => { setLoginName(e.target.value); setLoginError(""); }}
              onKeyDown={(e) => e.key === "Enter" && enter()} placeholder="напр. taras.mamai" />
          </div>
          <div style={{ marginTop: 14 }}>
            <label style={label} htmlFor="pwd">Пароль</label>
            <input id="pwd" type="password" autoComplete="current-password" value={loginPassword}
              onChange={(e) => { setLoginPassword(e.target.value); setLoginError(""); }}
              onKeyDown={(e) => e.key === "Enter" && enter()} placeholder="Пароль" />
          </div>
          {loginError && <p role="alert" style={{ marginTop: 12, marginBottom: 0, color: C.stop }}>{loginError}</p>}
          <button onClick={enter} disabled={loginBusy} style={{ ...addBtn, background: C.signal, width: "100%", padding: "12px 16px", marginTop: 18, fontWeight: 600, opacity: loginBusy ? 0.6 : 1 }}>{loginBusy ? "Входимо…" : "Увійти"}</button>
        </div>
      </div>
    );
  }
  async function enter() {
    const n = loginName.trim();
    if (!n) return setLoginError("Введіть логін.");
    if (!loginPassword) return setLoginError("Введіть пароль.");
    setLoginBusy(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: n, password: loginPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setLoginError(data.error || "Не вдалося увійти."); return; }
      signIn({ name: data.name, username: n.toLowerCase(), email: "", source: "manual", token: data.token, role: data.role, isAdmin: !!data.isAdmin });
    } catch (e) {
      setLoginError("Немає з'єднання з сервером.");
    } finally {
      setLoginBusy(false);
    }
  }

  if (!isAdmin && !isHrd) {
    return (
      <TeamDesk
        user={user}
        token={tokenRef.current}
        onSignOut={signOut}
        onApiError={onApiError}
      />
    );
  }

  return (
    <div className="td" style={{ background: C.paper, minHeight: "100vh", fontFamily: SANS, color: C.ink, fontSize: 14 }}>
      <style>{css}</style>

      <header style={{ borderBottom: "1px solid " + C.line, background: C.surface }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "18px 24px 0" }}>
          <div style={{ display: "flex", gap: 20, alignItems: "baseline", flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontFamily: SERIF, fontSize: 26, fontWeight: 600, letterSpacing: "-0.01em" }}>Переведення між проєктами</h1>
            <div className="num" style={{ display: "flex", gap: 18, color: C.muted, fontSize: 13 }}>
              <span>цього місяця {counts.month}</span><span>заплановано {counts.planned}</span><span>на двох і більше проєктах {counts.split}</span>
              {awaiting.length > 0 && <span style={{ color: C.warn }}>без погодження {awaiting.length}</span>}
              {objected.length > 0 && <span style={{ color: C.stop }}>із запереченням {objected.length}</span>}
            </div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
              <span style={{ color: C.ink2 }}>{user.name}{user.email ? " · " + user.email : ""}</span>
              <span style={{ background: C.signalSoft, color: C.signal, borderRadius: 3, padding: "2px 8px", fontSize: 12, fontWeight: 600 }}>{ROLE_LABEL[role]}</span>
              <button className="link" onClick={() => syncNow(false)} disabled={offline}
                title={offline ? "Спільне сховище недоступне" : "Оновити дані з спільного сховища"}
                style={{ color: syncState === "error" ? C.stop : C.muted, textDecoration: "none" }}>
                {offline ? "лише ця вкладка"
                  : syncState === "saving" ? "синхронізуємо…"
                  : syncState === "error" ? "збій синхронізації, спробувати ще"
                  : syncAt ? "оновлено " + pad(syncAt.getHours()) + ":" + pad(syncAt.getMinutes()) + " ⟳" : "синхронізувати ⟳"}
              </button>
              <button className="link" onClick={signOut}>вийти</button>
            </div>
          </div>
          {(() => {
            /* Навігація: 4 розділи, у кожному — свої вкладки. */
            const allowed = (k) => isAdmin || !["approve", "lists", "fin", "req", "remind"].includes(k);
            const TABS = {
              form: "Нове переведення", journal: "Журнал",
              approve: "Погодження" + (myPending.length ? " · " + myPending.length : ""),
              req: "Заявки" + (newRequests.length ? " · " + newRequests.length : ""),
              teams: "Табель команд", remind: "Нагадування", fin: "Місяць · фін. облік", report: "Звіт по місяцях",
              snap: "Зріз на дату", lists: "Довідник",
            };
            const SECTIONS = [
              { k: "moves", label: "Переведення", tabs: ["form", "journal", "approve", "req"], badge: (isAdmin ? myPending.length + newRequests.length : 0) },
              { k: "sheet", label: "Табель", tabs: ["teams", "remind", "fin", "report"] },
              { k: "snap", label: "Зріз на дату", tabs: ["snap"] },
              { k: "lists", label: "Довідник", tabs: ["lists"] },
            ].map((x) => ({ ...x, tabs: x.tabs.filter(allowed) })).filter((x) => x.tabs.length);
            const cur = SECTIONS.find((x) => x.tabs.includes(tab)) || SECTIONS[0];
            const scroll = { display: "flex", gap: 4, overflowX: "auto", flexWrap: "nowrap", scrollbarWidth: "none" };
            return (
              <>
                <nav aria-label="Розділи" style={{ ...scroll, marginTop: 14 }}>
                  {SECTIONS.map((x) => {
                    const on = x === cur;
                    return (
                      <button key={x.k} onClick={() => setTab(lastTab.current[x.k] && x.tabs.includes(lastTab.current[x.k]) ? lastTab.current[x.k] : x.tabs[0])} aria-current={on}
                        style={{ cursor: "pointer", background: "none", border: "none", padding: "10px 14px", whiteSpace: "nowrap", fontSize: 15,
                          color: on ? C.ink : C.muted, fontWeight: on ? 600 : 400,
                          borderBottom: "2px solid " + (on ? C.signal : "transparent"), marginBottom: -1 }}>
                        {x.label}
                        {x.badge ? <span style={{ marginLeft: 6, background: C.warnSoft, color: C.warn, borderRadius: 9, padding: "1px 7px", fontSize: 11.5, fontWeight: 600 }}>{x.badge}</span> : null}
                      </button>
                    );
                  })}
                </nav>
                {cur.tabs.length > 1 && (
                  <nav aria-label={cur.label} style={{ ...scroll, padding: "10px 0 12px", gap: 6 }}>
                    {cur.tabs.map((k) => (
                      <button key={k} onClick={() => setTab(k)} aria-current={tab === k}
                        style={{ cursor: "pointer", whiteSpace: "nowrap", borderRadius: 16, padding: "6px 13px", fontSize: 13,
                          border: "1px solid " + (tab === k ? C.ink : C.line), background: tab === k ? C.ink : C.surface,
                          color: tab === k ? "#fff" : C.ink2, fontWeight: tab === k ? 600 : 400 }}>{TABS[k]}</button>
                    ))}
                  </nav>
                )}
              </>
            );
          })()}
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>
        {!persistent && (
          <p role="alert" style={{ margin: "0 0 18px", background: C.warnSoft, border: "1px solid #E6CFA6", borderRadius: 3, padding: "12px 14px", color: C.warn }}>
            Сховище не підключене: сервер тримає дані в пам'яті й втратить їх при перезапуску. Підключіть Redis у Vercel → Storage.
          </p>
        )}

        {/* ── НОВЕ ПЕРЕВЕДЕННЯ ── */}
        {tab === "form" && employees.length === 0 && (
          <section style={{ ...card, padding: 40, textAlign: "center" }}>
            <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 22, fontWeight: 600 }}>Довідник співробітників порожній</h2>
            <p style={{ color: C.ink2, maxWidth: 520, margin: "10px auto 0" }}>
              Залийте вигрузку зі своєї HR-системи — Excel або CSV — і люди з'являться тут разом із посадами та проєктами.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 20, flexWrap: "wrap" }}>
              {isAdmin && <button style={{ ...addBtn, background: C.signal, padding: "12px 22px", fontWeight: 600 }}
                onClick={() => { setTab("lists"); setBook("emp"); }}>Перейти до довідника</button>}
              <button className="ghost" onClick={() => buildTemplate(allProjects, partners)}>Завантажити шаблон</button>
            </div>
          </section>
        )}

        {tab === "form" && employees.length > 0 && (
          <div className="cols" style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 20, alignItems: "start" }}>
            <aside style={{ ...card, overflow: "hidden", position: "sticky", top: 16 }}>
              <div style={{ padding: 12, borderBottom: "1px solid " + C.lineSoft }}>
                <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Пошук за ім'ям або проєктом" aria-label="Пошук співробітника" />
              </div>
              <div style={{ maxHeight: 480, overflowY: "auto" }}>
                {roster.length === 0 && <p style={{ padding: 16, color: C.muted, margin: 0 }}>Нікого не знайшли.</p>}
                {roster.map((e) => {
                  const on = e.id === selectedId;
                  return (
                    <button key={e.id} className="rosterItem" onClick={() => { setSelectedId(e.id); setErrors([]); resetDist(); }} aria-pressed={on}
                      style={{ display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                        background: on ? C.signalSoft : "transparent", border: "none", borderBottom: "1px solid " + C.lineSoft,
                        borderLeft: "3px solid " + (on ? C.signal : "transparent"), padding: "11px 13px" }}>
                      <div style={{ fontWeight: 600 }}>{e.name}</div>
                      {e.position && <div style={{ color: C.ink2, fontSize: 12, marginTop: 2 }}>{e.position}</div>}
                      <div style={{ color: C.muted, fontSize: 12.5, marginTop: 3 }}>{allocText(allocAt(e, transfers, today))}</div>
                    </button>
                  );
                })}
              </div>
            </aside>

            <section style={{ ...card, padding: 22 }}>
              {fromRequest && (
                <div role="status" style={{ margin: "0 0 16px", background: C.signalSoft, border: "1px solid #A9D5D8", borderRadius: 3, padding: "10px 14px", color: C.ink2, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                  <span>
                    Заповнено із заявки від <b>{fromRequest.requester || fromRequest.email}</b>, {fmtDT(fromRequest.submittedAt)}.
                    Перевірте й натисніть «Створити переведення» — заявка позначиться як оброблена.
                  </span>
                  <button className="link" style={{ marginLeft: "auto" }} onClick={() => { setFromRequest(null); resetDist(); setNote(""); setErrors([]); }}>скасувати</button>
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap", alignItems: "baseline" }}>
                <div>
                  <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 22, fontWeight: 600 }}>{employee?.name || "Оберіть співробітника"}</h2>
                  {employee?.position && <p style={{ margin: "3px 0 0", color: C.muted, fontSize: 13 }}>{employee.position}</p>}
                  <p style={{ margin: "4px 0 0", color: C.ink2 }}>Зараз: {allocText(currentAlloc)}</p>
                </div>
                {employee && <button className="ghost" onClick={() => setCardId(employee.id)}>Історія переведень</button>}
              </div>

              <div style={{ marginTop: 20, background: "#F4F7FC", border: "1px solid " + C.lineSoft, borderRadius: 4, padding: "20px 18px" }}>
                <div className="route" style={{ marginBottom: 10 }}>
                  <span style={{ ...label, margin: 0 }}>Зараз</span><span /><span style={{ ...label, margin: 0 }}>Після переведення</span>
                </div>
                <div className="route">
                  <div style={{ display: "grid", gap: 8 }}>
                    {currentAlloc.map((x, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, background: C.surface, border: "1px solid " + C.lineSoft, borderRadius: 3, padding: "11px 12px", minHeight: 42 }}>
                        <span>{x.project}</span><span className="num" style={{ color: C.muted }}>{round2(x.percent)}%</span>
                      </div>
                    ))}
                  </div>
                  <div className="spine">
                    <span className="num" style={{ position: "relative", background: "#F4F7FC", padding: "3px 8px", color: C.signal, fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap" }}>{fmt(effectiveDate)}</span>
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {dist.map((r, i) => (
                      <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 92px 30px", gap: 6, alignItems: "center" }}>
                        <input type="text" list="projects" value={r.project} onChange={(ev) => setRow(i, { project: ev.target.value })}
                          placeholder="проєкт" aria-label={"Проєкт " + (i + 1)} style={{ minHeight: 42 }} />
                        <div style={{ position: "relative" }}>
                          <input type="number" className="num" min="0" max="100" value={r.percent}
                            onChange={(ev) => setRow(i, { percent: ev.target.value === "" ? "" : Number(ev.target.value) })}
                            aria-label={"Відсоток на проєкті " + (i + 1)} style={{ minHeight: 42, paddingRight: 26, textAlign: "right" }} />
                          <span style={{ position: "absolute", right: 9, top: 12, color: C.muted, pointerEvents: "none" }}>%</span>
                        </div>
                        {dist.length > 1 ? <button className="del" onClick={() => dropRow(i)} aria-label="Прибрати проєкт з розподілу">✕</button> : <span />}
                      </div>
                    ))}
                    <datalist id="projects">{activeProjects.map((p) => <option key={p} value={p} />)}</datalist>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}>
                      <button className="ghost" onClick={addRow}>+ Ще один проєкт</button>
                      {dist.length > 1 && <button className="ghost" onClick={evenOut}>Порівну</button>}
                      <span className="num" style={{ marginLeft: "auto", fontWeight: 600, color: total === 100 ? C.signal : C.stop }}>
                        {total === 100 ? "разом 100%" : "разом " + round2(total) + "% — лишилось " + round2(100 - total) + "%"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginTop: 20 }}>
                <div>
                  <label style={label} htmlFor="eff">Дата переведення</label>
                  <input id="eff" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
                  {effectiveDate && effectiveDate < today && <p style={{ margin: "6px 0 0", fontSize: 12.5, color: C.warn }}>Дата в минулому — зарахується заднім числом.</p>}
                </div>
                <div>
                  <span style={label}>Тип</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setTemporary(false)} aria-pressed={!temporary} style={{ ...chip(!temporary), flex: 1, padding: "9px 10px" }}>Постійне</button>
                    <button onClick={() => setTemporary(true)} aria-pressed={temporary} style={{ ...chip(temporary), flex: 1, padding: "9px 10px" }}>Тимчасове</button>
                  </div>
                </div>
                <div>
                  <label style={{ ...label, color: temporary ? C.muted : C.line }} htmlFor="ret">Дата повернення</label>
                  <input id="ret" type="date" value={returnDate} disabled={!temporary} onChange={(e) => setReturnDate(e.target.value)}
                    style={{ background: temporary ? C.surface : "#F1F4F9", color: temporary ? C.ink : C.muted }} />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginTop: 16 }}>
                <div>
                  <span style={label}>Подає</span>
                  <div style={{ background: "#F1F4F9", border: "1px solid " + C.lineSoft, borderRadius: 3, padding: "9px 10px", color: C.ink2 }}>{user.name}</div>
                </div>
                <div>
                  <label style={label} htmlFor="reason">Підстава</label>
                  <input id="reason" type="text" list="reasons" value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder="оберіть зі списку або впишіть нову" />
                  <datalist id="reasons">{allReasons.map((r) => <option key={r} value={r} />)}</datalist>
                </div>
                <div>
                  <label style={label} htmlFor="note">Коментар</label>
                  <input id="note" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="необов'язково" />
                </div>
              </div>

              {pending && (
                <p style={{ marginTop: 16, marginBottom: 0, background: C.warnSoft, border: "1px solid #E6CFA6", borderRadius: 3, padding: "10px 12px", color: C.warn }}>
                  У {employee.name} вже є переведення на {fmt(pending.effectiveDate)} ({allocText(pending.to)}). Скасуйте його в журналі, якщо це заміна.
                </p>
              )}
              {errors.length > 0 && (
                <div role="alert" style={{ marginTop: 16, background: C.stopSoft, border: "1px solid #E2BCC6", borderRadius: 3, padding: "12px 14px", color: C.stop }}>
                  <strong style={{ display: "block", marginBottom: 6 }}>Перевірте форму</strong>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 20, flexWrap: "wrap" }}>
                <button onClick={submit} style={{ cursor: "pointer", background: C.signal, color: "#fff", border: "none", borderRadius: 3, padding: "12px 22px", fontWeight: 600 }}>
                  Створити переведення
                </button>
                <span style={{ color: C.muted, fontSize: 12.5 }}>Запис піде в журнал за вашим ім'ям і в звіт за {monthLabel(monthKey(effectiveDate || today)).toLowerCase()}.</span>
              </div>
            </section>
          </div>
        )}

        {/* ── ЗАЯВКИ З GOOGLE ФОРМИ ── */}
        {tab === "req" && isAdmin && (() => {
          const done = requests.filter((r) => r.status !== "new").slice().sort((a, b) => (b.decidedAt || "").localeCompare(a.decidedAt || "")).slice(0, 30);
          const fresh = newRequests.slice().sort((a, b) => (a.submittedAt || "").localeCompare(b.submittedAt || ""));
          const reqCard = (r) => {
            const emp = employees.find((e) => e.id === r.employeeId) || employees.find((e) => e.name.trim().toLowerCase() === r.employee.trim().toLowerCase());
            const now = emp ? allocAt(emp, transfers, today) : [];
            return (
              <div key={r.id} style={{ borderTop: "1px solid " + C.lineSoft, padding: "16px 18px" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{r.employee}</span>
                  {emp ? <span style={{ color: C.muted }}>{allocText(now)}</span> : <span style={{ color: C.stop, fontSize: 12.5 }}>немає в довіднику</span>}
                  <span style={{ color: C.line }}>→</span>
                  <span style={{ fontWeight: 600 }}>{allocText(r.alloc)}</span>
                  <span className="num" style={{ color: C.ink2 }}>з {fmt(r.effectiveDate)}</span>
                  {r.temporary && <span style={{ color: C.ink2, fontSize: 12.5 }}>тимчасово до {r.returnDate ? fmt(r.returnDate) : "?"}</span>}
                </div>
                <div style={{ color: C.muted, fontSize: 12.5, marginTop: 4 }}>
                  {r.reason || "підставу не вказано"} · подав(ла) {r.requester || "—"}{r.email ? " (" + r.email + ")" : ""}, {fmtDT(r.submittedAt)}
                </div>
                <div style={{ marginTop: 6, fontSize: 13, color: r.agreedWith ? C.ink2 : C.warn }}>
                  Погоджено з: {r.agreedWith ? <b>{r.agreedWith}</b> : "не вказано"}
                </div>
                {r.note && <p style={{ margin: "8px 0 0", color: C.ink2, whiteSpace: "pre-wrap" }}>{r.note}</p>}
                {r.status === "new" ? (
                  <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                    <button style={{ ...addBtn, background: C.signal }} onClick={() => takeRequest(r)}>Створити переведення</button>
                    <button className="ghost" style={{ color: C.stop, borderColor: "#E2BCC6" }} onClick={() => rejectRequest(r)}>Відхилити</button>
                  </div>
                ) : (
                  <div style={{ marginTop: 10, fontSize: 12.5, color: C.ink2, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                    <span style={{ background: r.status === "done" ? C.signalSoft : C.stopSoft, color: r.status === "done" ? C.signal : C.stop, borderRadius: 3, padding: "2px 8px", fontWeight: 600 }}>
                      {r.status === "done" ? "створено переведення" : "відхилено"}
                    </span>
                    <span>{r.decidedBy}, {fmtDT(r.decidedAt)}{r.comment ? " · " + r.comment : ""}</span>
                    <button className="link" style={{ fontSize: 12.5 }} onClick={() => decideRequest(r, "new")}>повернути в нові</button>
                  </div>
                )}
              </div>
            );
          };
          return (
            <div style={{ display: "grid", gap: 20 }}>
              <section style={{ ...card, padding: "16px 18px" }}>
                <p style={{ margin: 0, color: C.ink2 }}>
                  Сюди потрапляють заявки з Google Форми. «Створити переведення» підставляє дані у форму нового переведення —
                  ви перевіряєте й зберігаєте, заявка позначається як оброблена. Автор заявки бачить лише саму форму.
                </p>
                {!formReady && (
                  <p style={{ margin: "10px 0 0", background: C.warnSoft, border: "1px solid #E6CFA6", borderRadius: 3, padding: "10px 12px", color: C.warn }}>
                    Форма ще не підключена: додайте у Vercel змінну FORM_SECRET (довгий випадковий рядок) і зробіть Redeploy.
                  </p>
                )}
              </section>
              {[{ k: "new", title: "Нові", items: fresh, empty: "Нових заявок немає." }, { k: "done", title: "Оброблені", items: done, empty: "Ще нічого не оброблено." }].map((b) => (
                <section key={b.k} style={{ ...card, overflow: "hidden" }}>
                  <div style={{ padding: "14px 18px" }}>
                    <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 19, fontWeight: 600 }}>{b.title} <span className="num" style={{ color: C.muted, fontWeight: 400 }}>{b.items.length}</span></h2>
                  </div>
                  {b.items.length ? b.items.map(reqCard) : <p style={{ padding: "0 18px 18px", margin: 0, color: C.muted }}>{b.empty}</p>}
                </section>
              ))}
            </div>
          );
        })()}

        {/* ── ЖУРНАЛ ── */}
        {tab === "journal" && (
          <div style={{ display: "grid", gap: 20 }}>
            <section style={{ ...card, overflow: "hidden" }}>
              <div style={{ padding: "16px 18px", borderBottom: "1px solid " + C.lineSoft, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <input type="text" value={journalQuery} onChange={(e) => setJournalQuery(e.target.value)}
                  placeholder="Пошук: ім'я, проєкт, People Partner" aria-label="Пошук у журналі" style={{ width: 260 }} />
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {[["all", "Усі"], ["planned", "Заплановані"], ["active", "Діють"], ["done", "Повернулись"], ["cancelled", "Скасовані"]].map(([k, l]) => (
                    <button key={k} onClick={() => setStatusFilter(k)} aria-pressed={statusFilter === k} style={chip(statusFilter === k)}>{l}</button>
                  ))}
                </div>
                <span style={{ color: C.muted, fontSize: 12.5 }}>
                  {isAdmin ? "Ви адміністратор: можете правити будь-який запис." : "Правити можна лише свої записи; видаляти — тільки адміністратор."}
                </span>
                <button onClick={exportJournal} disabled={!journal.length}
                  style={{ marginLeft: "auto", cursor: journal.length ? "pointer" : "not-allowed", padding: "8px 14px", borderRadius: 3, border: "1px solid " + C.line, background: C.surface, color: journal.length ? C.ink2 : C.muted }}>
                  Вивантажити Excel
                </button>
              </div>
              {journal.length === 0 ? (
                <p style={{ padding: "34px 18px", margin: 0, color: C.muted, textAlign: "center" }}>
                  {transfers.length === 0 ? "Переведень ще немає. Створіть перше на вкладці «Нове переведення»." : "За цим фільтром записів немає."}
                </p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table>
                    <thead><tr><th>Співробітник</th><th>Було</th><th>Стало</th><th>Дата</th><th>Повернення</th><th>Підстава</th><th>Подав</th><th>Статус</th><th>Погодження</th><th /></tr></thead>
                    <tbody>
                      {journal.slice().sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate)).map((t) => {
                        const st = statusOf(t, today);
                        return (
                          <tr key={t.id}>
                            <td><button className="link" style={{ fontWeight: 600 }} onClick={() => setCardId(t.employeeId)}>{nameOf(t)}</button></td>
                            <td style={{ color: C.muted }}>{allocText(t.from)}</td>
                            <td style={{ fontWeight: 600 }}>{allocText(t.to)}</td>
                            <td className="num" style={{ whiteSpace: "nowrap" }}>{fmt(t.effectiveDate)}</td>
                            <td className="num" style={{ whiteSpace: "nowrap", color: t.temporary ? C.ink : C.muted }}>{t.temporary ? fmt(t.returnDate) : "постійне"}</td>
                            <td>{t.reason}{t.note && <div style={{ color: C.muted, fontSize: 12 }}>{t.note}</div>}</td>
                            <td>{t.partner}
                              <div style={{ color: C.muted, fontSize: 12 }}>{fmtDT(t.createdAt)}</div>
                              {t.editedBy && <div style={{ color: C.warn, fontSize: 12 }}>змінив(ла) {t.editedBy}, {fmtDT(t.editedAt)}</div>}
                            </td>
                            <td><span style={{ background: STATUS[st].bg, color: STATUS[st].fg, borderRadius: 3, padding: "3px 8px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{STATUS[st].label}</span></td>
                            <td>
                              {(() => {
                                const ap = approvalState(t, settings.approvalMode);
                                const req = (t.approvals || []).filter((a) => isRequired(a, settings.approvalMode));
                                const ok = req.filter((a) => a.status === "approved").length;
                                return (
                                  <span style={{ background: APPROVAL[ap].bg, color: APPROVAL[ap].fg, borderRadius: 3, padding: "3px 8px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
                                    {APPROVAL[ap].label}{req.length > 1 ? " " + ok + "/" + req.length : ""}
                                  </span>
                                );
                              })()}
                            </td>
                            <td style={{ whiteSpace: "nowrap" }}>
                              {canCancel(t) && <button className="link" style={{ color: C.ink2, marginRight: 12 }} onClick={() => openEdit(t)}>Змінити</button>}
                              {canCancel(t)
                                ? <button className="link" style={{ color: C.ink2, marginRight: 12 }} onClick={() => toggleCancel(t)}>{t.cancelled ? "Відновити" : "Скасувати"}</button>
                                : <span style={{ color: C.muted, fontSize: 12.5, marginRight: 12 }} title={"Редагувати може " + t.partner + " або адміністратор"}>запис {t.partner}</span>}
                              {canDelete() && <button className="link" style={{ color: C.stop }} onClick={() => removeTransfer(t)}>Видалити</button>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section style={{ ...card, padding: "16px 18px" }}>
              <button className="link" style={{ color: C.ink2, fontWeight: 600 }} onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
                {showLog ? "Сховати журнал дій" : "Журнал дій People Partners (" + log.length + ")"}
              </button>
              {showLog && (log.length === 0
                ? <p style={{ color: C.muted, margin: "12px 0 0" }}>Дій ще не було. Тут з'являться створення, скасування й заливки списків із іменем того, хто це зробив.</p>
                : <div style={{ marginTop: 12, maxHeight: 320, overflowY: "auto" }}>
                    <table>
                      <thead><tr><th style={{ width: 140 }}>Коли</th><th style={{ width: 170 }}>Хто</th><th>Що зробив</th></tr></thead>
                      <tbody>{log.map((l) => (
                        <tr key={l.id}>
                          <td className="num" style={{ whiteSpace: "nowrap", color: C.muted }}>{fmtDT(l.at)}</td>
                          <td>{l.who}</td>
                          <td>{l.action}: {l.details}</td>
                        </tr>))}
                      </tbody>
                    </table>
                  </div>)}
            </section>
          </div>
        )}

        {/* ── ПОГОДЖЕННЯ ── */}
        {tab === "approve" && isAdmin && (() => {
          const mode = settings.approvalMode;
          const card2 = (t, onlyMine) => {
            const list = (t.approvals || []).filter((a) => !onlyMine || (a.status === "pending" && canDecide(a)));
            if (!list.length) return null;
            const st = statusOf(t, today);
            return (
              <div key={t.id} style={{ borderTop: "1px solid " + C.lineSoft, padding: "16px 18px" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <button className="link" style={{ fontWeight: 600, color: C.ink, textDecoration: "none", fontSize: 15 }} onClick={() => setCardId(t.employeeId)}>{nameOf(t)}</button>
                  <span style={{ color: C.muted }}>{allocText(t.from)}</span>
                  <span style={{ color: C.line }}>→</span>
                  <span style={{ fontWeight: 600 }}>{allocText(t.to)}</span>
                  <span className="num" style={{ color: C.ink2 }}>з {fmt(t.effectiveDate)}</span>
                  <span style={{ background: STATUS[st].bg, color: STATUS[st].fg, borderRadius: 3, padding: "2px 7px", fontSize: 11.5, fontWeight: 600 }}>{STATUS[st].label}</span>
                </div>
                <div style={{ color: C.muted, fontSize: 12.5, marginTop: 4 }}>
                  {t.reason}{t.note ? " · " + t.note : ""} · подав(ла) {t.partner}, {fmtDT(t.createdAt)}
                  {t.effectiveDate <= today && <span style={{ color: C.warn }}> · вже діє {daysBetween(t.effectiveDate, today)} {plural(daysBetween(t.effectiveDate, today), "день", "дні", "днів")}</span>}
                </div>

                <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
                  {list.map((a) => {
                    const mine = canDecide(a), key = t.id + ":" + a.project;
                    return (
                      <div key={a.project} style={{ background: "#F4F7FC", border: "1px solid " + C.lineSoft, borderRadius: 3, padding: "10px 12px" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                          <span style={{ fontWeight: 600 }}>{a.project}</span>
                          <span style={{ color: C.muted, fontSize: 12.5 }}>
                            {a.role === "give" ? "віддає" : "приймає"} {round2(a.delta)}%
                            {!isRequired(a, mode) && " · до відома"}
                          </span>
                          <span style={{ color: C.muted, fontSize: 12.5 }}>PM: {a.pm || "не призначений"}</span>
                          <span style={{ marginLeft: "auto", background: APPROVAL[a.status === "pending" ? "pending" : a.status === "approved" ? "approved" : "rejected"].bg,
                            color: APPROVAL[a.status === "pending" ? "pending" : a.status === "approved" ? "approved" : "rejected"].fg,
                            borderRadius: 3, padding: "2px 8px", fontSize: 12, fontWeight: 600 }}>
                            {a.status === "pending" ? "очікує" : a.status === "approved" ? "погодив(ла) " + a.by : "заперечив(ла) " + a.by}
                          </span>
                        </div>
                        {a.comment && <p style={{ margin: "6px 0 0", color: C.ink2, fontSize: 13 }}>{a.comment}</p>}
                        {a.status === "pending" && mine && (
                          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                            <input type="text" value={approveNote[key] || ""} onChange={(e) => setApproveNote((n) => ({ ...n, [key]: e.target.value }))}
                              placeholder="коментар (обов'язковий для заперечення)" aria-label="Коментар до рішення" style={{ flex: "1 1 220px", width: "auto" }} />
                            <button onClick={() => decide(t, a.project, true)} style={{ ...addBtn, background: C.signal }}>Погодити</button>
                            <button onClick={() => decide(t, a.project, false)} className="ghost" style={{ color: C.stop, borderColor: "#E2BCC6" }}>Заперечити</button>
                          </div>
                        )}
                        {a.status === "pending" && !mine && !a.pm && (
                          <p style={{ margin: "6px 0 0", color: C.warn, fontSize: 12.5 }}>Проєкту не призначений PM — зробіть це в довіднику, інакше нікому погоджувати.</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          };
          const blocks = [
            { key: "mine", title: "Чекають на ваше рішення", items: myPending, only: true,
              empty: "Нічого не чекає на вас. Ви бачите тут переведення тих проєктів, де ви PM." },
            { key: "obj", title: "Із запереченням", items: objected, only: false, empty: "Заперечень немає." },
            { key: "wait", title: "Ще не погоджені", items: awaiting.filter((t) => !myPending.includes(t)), only: false, empty: "Усе погоджено." },
          ];
          return (
            <div style={{ display: "grid", gap: 20 }}>
              <section style={{ ...card, padding: "16px 18px" }}>
                <p style={{ margin: 0, color: C.ink2 }}>
                  Переведення діють з дати незалежно від погодження — PM підтверджують уже доконане.
                  Обов'язкове слово {mode === "both" ? "обох сторін: хто віддає і хто приймає" : "того, хто віддає людину"}; змінити можна в довіднику, у налаштуваннях.
                </p>
              </section>
              {blocks.map((b) => (
                <section key={b.key} style={{ ...card, overflow: "hidden" }}>
                  <div style={{ padding: "14px 18px" }}>
                    <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 19, fontWeight: 600 }}>
                      {b.title} <span className="num" style={{ color: C.muted, fontWeight: 400 }}>{b.items.length}</span>
                    </h2>
                  </div>
                  {b.items.length === 0
                    ? <p style={{ padding: "0 18px 18px", margin: 0, color: C.muted }}>{b.empty}</p>
                    : b.items.slice().sort((x, y) => x.effectiveDate.localeCompare(y.effectiveDate)).map((t) => card2(t, b.only))}
                </section>
              ))}
            </div>
          );
        })()}

        {/* ── ЗРІЗ НА ДАТУ ── */}
        {tab === "snap" && (
          <div style={{ display: "grid", gap: 20 }}>
            <section style={{ ...card, padding: 22 }}>
              <div style={{ display: "flex", gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ width: 190 }}>
                  <label style={label} htmlFor="snap">Стан на дату</label>
                  <input id="snap" type="date" value={snapDate} onChange={(e) => setSnapDate(e.target.value)} />
                </div>
                <div style={{ display: "flex", gap: 6, paddingBottom: 2, flexWrap: "wrap" }}>
                  <button onClick={() => setSnapDate(today)} style={chip(snapDate === today)}>сьогодні</button>
                  <button onClick={() => setSnapDate(addMonths(today, 1))} style={chip(snapDate === addMonths(today, 1))}>через місяць</button>
                  <button onClick={() => setSnapDate(addMonths(today, 3))} style={chip(snapDate === addMonths(today, 3))}>через квартал</button>
                  <button onClick={() => setSnapDate(addMonths(today, -1))} style={chip(snapDate === addMonths(today, -1))}>місяць тому</button>
                </div>
                <button onClick={exportSnapshot} style={{ marginLeft: "auto", cursor: "pointer", padding: "8px 14px", borderRadius: 3, border: "1px solid " + C.line, background: C.surface, color: C.ink2 }}>
                  Вивантажити зріз в Excel
                </button>
              </div>
              <p style={{ margin: "14px 0 0", color: C.ink2 }}>
                {fmt(snapDate)}: {employees.length} {plural(employees.length, "співробітник", "співробітники", "співробітників")} на {snapshot.names.length} {plural(snapshot.names.length, "проєкті", "проєктах", "проєктах")}
                {snapshot.split > 0 && ", з них " + snapshot.split + " на кількох одночасно"}
                {snapshot.between > 0 && (snapDate > today
                  ? " · до цієї дати спрацює " + snapshot.between + " " + plural(snapshot.between, "переведення", "переведення", "переведень")
                  : " · відтоді сталося " + snapshot.between + " " + plural(snapshot.between, "переведення", "переведення", "переведень"))}
              </p>
            </section>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 20 }}>
              {snapshot.names.map((p) => {
                const list = snapshot.byProject[p], fte = fteIn(list);
                return (
                  <section key={p} style={{ ...card, padding: 18 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                      <h3 style={{ margin: 0, fontFamily: SERIF, fontSize: 18, fontWeight: 600 }}>{p}</h3>
                      <span className="num" style={{ color: C.muted, fontSize: 12.5 }}>{list.length} {plural(list.length, "особа", "особи", "осіб")} · {round2(fte)} {plural(Math.round(fte), "ставка", "ставки", "ставок")}</span>
                    </div>
                    <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0 }}>
                      {list.map((x) => (
                        <li key={x.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderTop: "1px solid " + C.lineSoft }}>
                          <button className="link" style={{ color: C.ink, textDecoration: "none", textAlign: "left" }} onClick={() => setCardId(x.id)}>{x.name}</button>
                          <span className="num" style={{ color: x.percent === 100 ? C.muted : C.signal, fontWeight: x.percent === 100 ? 400 : 600 }}>{round2(x.percent)}%</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          </div>
        )}

        {/* ── КОМАНДИ І ТЕГИ ── */}
        {tab === "teams" && (
          <div style={{ display: "grid", gap: 20 }}>
            <section style={{ ...card, padding: "16px 20px" }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 21, fontWeight: 600 }}>Табель розподілу</h2>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 8 }}>
                  <button className="ghost" onClick={() => setPeriod((p) => shiftPeriod(p, -1))} aria-label="Попередній період">←</button>
                  <span className="num" style={{ fontWeight: 600, minWidth: 210, textAlign: "center" }}>{periodLabel(period)}</span>
                  <button className="ghost" onClick={() => setPeriod((p) => shiftPeriod(p, 1))} aria-label="Наступний період">→</button>
                </div>
                {pKey !== periodKey(periodOf(today).y, periodOf(today).m, periodOf(today).half) && (
                  <button className="link" onClick={() => setPeriod(periodOf(today))}>до поточного</button>
                )}
                <button onClick={exportTags} style={{ marginLeft: "auto", cursor: "pointer", padding: "8px 14px", borderRadius: 3, border: "1px solid " + C.line, background: C.surface, color: C.ink2 }}>
                  Вивантажити теги
                </button>
              </div>
              <p style={{ margin: "10px 0 0", color: C.muted, fontSize: 12.5 }}>
                Відсотки подають за 01–15 і 16–кінець місяця. Кожен період зберігається окремо, тож історія лишається.
                Можна вносити години (перемикач «% / години» у команді): відсоток проєкту — його частка від усіх годин людини.
                Тег кожної людини збирається з її рядка.
              </p>
              {noCode.length > 0 && (
                <p style={{ margin: "12px 0 0", background: C.warnSoft, border: "1px solid #E6CFA6", borderRadius: 3, padding: "10px 12px", color: C.warn }}>
                  Без коду {noCode.length} {plural(noCode.length, "проєкт", "проєкти", "проєктів")} — у тезі вони стануть «?».
                  {isAdmin ? <button className="link" style={{ marginLeft: 8, color: C.warn }} onClick={() => { setTab("lists"); setBook("proj"); }}>Задати коди</button> : " Коди задає адміністратор."}
                </p>
              )}
            </section>

            {teams.length === 0 && (
              <section style={{ ...card, padding: 30, textAlign: "center", color: C.muted }}>
                {isAdmin ? "Команд ще немає. Створюються в «Довідник → Налаштування»." : "За вами поки не закріплено жодної команди. Попросіть адміністратора вписати «" + user.name + "» у поле «Відповідальний за %»."}
              </section>
            )}

            {teams.map((t) => {
              const members = teamMembers(t.id), mine = canEditTeam(t), cols = teamColumns(t);
              const sub = (t.submitted || {})[pKey], locked = !mine || !!sub, inHours = unitOf(t) === "h";
              const free = employees.filter((e) => !e.teamId);
              const hist = showHistory === t.id;
              return (
                <section key={t.id} style={{ ...card, overflow: "hidden" }}>
                  <div style={{ padding: "14px 20px", borderBottom: "1px solid " + C.lineSoft, display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                    <h3 style={{ margin: 0, fontFamily: SERIF, fontSize: 19, fontWeight: 600 }}>{t.name}</h3>
                    <span style={{ color: C.muted, fontSize: 12.5 }}>вносить {t.owner || "адміністратор"}</span>
                    {members.length > 0 && (
                      <span className="num" style={{ fontSize: 12.5, color: filledIn(t.id) === members.length ? C.signal : C.warn }}>
                        заповнено {filledIn(t.id)} з {members.length}
                      </span>
                    )}
                    {sub && (
                      <span style={{ background: C.signalSoft, color: C.signal, borderRadius: 3, padding: "2px 8px", fontSize: 12, fontWeight: 600 }}>
                        подано · {sub.by}, {fmtDT(sub.at)}
                      </span>
                    )}
                    <div role="group" aria-label={"Одиниці табеля " + t.name} style={{ display: "flex", marginLeft: "auto" }}>
                      {[["pct", "%"], ["h", "години"]].map(([k, l]) => (
                        <button key={k} onClick={() => setUnits((u) => ({ ...u, [t.id]: k }))} aria-pressed={unitOf(t) === k}
                          style={{ cursor: "pointer", padding: "4px 12px", fontSize: 12.5, border: "1px solid " + (unitOf(t) === k ? C.ink2 : C.line),
                            background: unitOf(t) === k ? C.ink : C.surface, color: unitOf(t) === k ? "#fff" : C.ink2,
                            borderRadius: k === "pct" ? "3px 0 0 3px" : "0 3px 3px 0", marginLeft: k === "h" ? -1 : 0 }}>{l}</button>
                      ))}
                    </div>
                    <button className="link" style={{ fontSize: 12.5 }}
                      title="Лише проєкти, на яких у команди вже були відсотки, або всі активні проєкти"
                      onClick={() => setCompact((m) => ({ ...m, [t.id]: !(m[t.id] ?? true) }))}>
                      {(compact[t.id] ?? true) ? "показати всі проєкти" : "лише проєкти команди"}
                    </button>
                    <button className="link" style={{ fontSize: 12.5 }} onClick={() => setShowHistory(hist ? null : t.id)}>
                      {hist ? "сховати історію" : "історія періодів"}
                    </button>
                  </div>

                  {members.length === 0 ? (
                    <p style={{ padding: "18px 20px", margin: 0, color: C.muted }}>
                      {isAdmin ? "До команди ще нікого не прикріплено. Внизу є поле «Прикріпити людину» — у підказках ті, хто ще не в жодній команді." : "До команди ще нікого не прикріплено — людей додає адміністратор."}
                    </p>
                  ) : cols.length === 0 ? (
                    <p style={{ padding: "18px 20px", margin: 0, color: C.muted }}>
                      {orderedProjects.length === 0
                        ? "У довіднику ще немає жодного проєкту — колонки беруться звідти. "
                        : "У цьому періоді ще нічого не заповнено. "}
                      {isAdmin && <button className="link" onClick={() => { setTab("lists"); setBook("proj"); }}>Відкрити довідник проєктів</button>}
                    </p>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table>
                        <thead>
                          <tr>
                            <th style={{ minWidth: 200, position: "sticky", left: 0, background: C.surface }}>ПІБ</th>
                            {cols.map((c) => (
                              <th key={c} style={{ minWidth: 92, textAlign: "center" }}>
                                <div>{c}</div>
                                <div className="num" style={{ fontWeight: 400, color: codes[c] ? C.muted : C.stop }}>{codes[c] || "без коду"}</div>
                              </th>
                            ))}
                            <th style={{ minWidth: 80, textAlign: "center" }}>Разом</th>
                            <th style={{ minWidth: 200 }}>Тег</th>
                          </tr>
                        </thead>
                        <tbody>
                          {members.map((e) => {
                            const tot = rowTotal(e.id), a = personAlloc(e), tg = tagOf(a, codes);
                            return (
                              <tr key={e.id}>
                                <td style={{ position: "sticky", left: 0, background: C.surface }}>
                                  <button className="link" style={{ color: C.ink, textDecoration: "none", fontWeight: 600 }} onClick={() => setCardId(e.id)}>{e.name}</button>
                                  {e.position && <div style={{ color: C.muted, fontSize: 11.5 }}>{e.position}</div>}
                                </td>
                                {cols.map((c) => (
                                  <td key={c} style={{ padding: 4 }}>
                                    {inHours ? (
                                      <>
                                        <input type="number" className="num" min="0" max={MAX_HOURS} step="0.5" value={hoursValue(e.id, c)} disabled={locked}
                                          onChange={(ev) => setHoursCell(e.id, c, ev.target.value)} aria-label={e.name + ", " + c + ", годин"}
                                          style={{ textAlign: "center", padding: "7px 4px", background: locked ? "#F4F6FA" : C.surface,
                                            border: "1px solid " + (hoursValue(e.id, c) !== "" ? C.line : C.lineSoft) }} />
                                        <div className="num" style={{ textAlign: "center", fontSize: 11, color: C.muted, minHeight: 14 }}>{cellValue(e.id, c) !== "" ? cellValue(e.id, c) + "%" : ""}</div>
                                      </>
                                    ) : (
                                      <input type="number" className="num" min="0" max="100" value={cellValue(e.id, c)} disabled={locked}
                                        onChange={(ev) => setCell(e.id, c, ev.target.value)} aria-label={e.name + ", " + c}
                                        style={{ textAlign: "center", padding: "7px 4px", background: locked ? "#F4F6FA" : C.surface,
                                          border: "1px solid " + (cellValue(e.id, c) ? C.line : C.lineSoft) }} />
                                    )}
                                  </td>
                                ))}
                                <td className="num" style={{ textAlign: "center", fontWeight: 600, color: tot === 100 ? C.signal : tot === 0 ? C.muted : C.stop }}>
                                  {inHours && hoursIn(e.id).length > 0 && <div style={{ fontWeight: 400, color: C.ink2 }}>{round2(hoursTotal(hoursIn(e.id)))} год</div>}
                                  {tot ? round2(tot) + "%" : "—"}
                                  {inHours && tot > 0 && !hasHours(entryOf(e.id, pKey)) && <div style={{ fontWeight: 400, fontSize: 11, color: C.warn }}>внесено у %</div>}
                                </td>
                                <td className="num" style={{ fontWeight: 600, color: tg ? C.ink : C.muted, wordBreak: "break-all", fontSize: 12.5 }}>{tg || "—"}</td>
                              </tr>
                            );
                          })}
                          <tr>
                            <td style={{ position: "sticky", left: 0, background: "#F4F7FC", color: C.muted, fontWeight: 600 }}>Разом по продукту</td>
                            {cols.map((c) => (
                              <td key={c} className="num" style={{ textAlign: "center", background: "#F4F7FC", color: C.ink2 }}>{inHours
                                ? round2(members.reduce((a, e) => a + (Number(hoursValue(e.id, c)) || 0), 0)) + " год"
                                : colTotal(t.id, c) || "—"}</td>
                            ))}
                            <td colSpan={2} style={{ background: "#F4F7FC" }} />
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}

                  {mine && (
                    <div style={{ display: "flex", gap: 10, padding: "14px 20px", borderTop: "1px solid " + C.lineSoft, flexWrap: "wrap", alignItems: "center" }}>
                      {!sub ? (
                        <>
                          <button className="ghost" onClick={() => copyPrevPeriod(t)}>Перенести з попереднього періоду</button>
                          {members.length > 0 && <button style={addBtn} onClick={() => submitPeriod(t)}>Подати період</button>}
                        </>
                      ) : (
                        <span style={{ color: C.muted, fontSize: 12.5 }}>
                          Період закритий. {isAdmin ? "" : "Відкрити може адміністратор."}
                          {isAdmin && <button className="link" style={{ marginLeft: 8 }} onClick={() => reopenPeriod(t)}>Відкрити знову</button>}
                        </span>
                      )}
                      {isAdmin && (
                        <>
                          <input type="text" list={"free-" + t.id} value={addMember[t.id] || ""} placeholder="Прикріпити людину"
                            aria-label={"Додати людину до " + t.name} style={{ flex: "1 1 200px", width: "auto", marginLeft: "auto" }}
                            onChange={(e) => setAddMember((m) => ({ ...m, [t.id]: e.target.value }))} />
                          <datalist id={"free-" + t.id}>{free.map((e) => <option key={e.id} value={e.name}>{e.position}</option>)}</datalist>
                          <button className="ghost" onClick={() => {
                            const f = free.find((x) => x.name === (addMember[t.id] || "").trim());
                            if (!f) return setToast("Оберіть людину зі списку — там ті, хто ще не в команді.");
                            joinTeam(f.id, t.id); setAddMember((m) => ({ ...m, [t.id]: "" }));
                          }}>Прикріпити</button>
                        </>
                      )}
                    </div>
                  )}

                  {hist && (
                    <div style={{ padding: "14px 20px", borderTop: "1px solid " + C.lineSoft, background: "#F7F9FC" }}>
                      <table>
                        <thead><tr><th>Період</th><th style={{ width: 130 }}>Заповнено</th><th style={{ width: 220 }}>Подано</th><th style={{ width: 90 }} /></tr></thead>
                        <tbody>
                          {Array.from({ length: 12 }, (_, i) => shiftPeriod(periodOf(today), -i)).map((pp) => {
                            const k = periodKey(pp.y, pp.m, pp.half);
                            const filled = teamMembers(t.id).filter((e) => allocIn(e.id, k).length).length;
                            const sb = (t.submitted || {})[k];
                            if (!filled && !sb) return null;
                            return (
                              <tr key={k}>
                                <td style={{ fontWeight: k === pKey ? 600 : 400 }}>{periodLabel(pp)}</td>
                                <td className="num">{filled} з {teamMembers(t.id).length}</td>
                                <td style={{ color: sb ? C.ink2 : C.muted, fontSize: 12.5 }}>{sb ? sb.by + ", " + fmtDT(sb.at) : "не подано"}</td>
                                <td>{k !== pKey && <button className="link" onClick={() => setPeriod(pp)}>відкрити</button>}</td>
                              </tr>
                            );
                          })}
                          {!teamMembers(t.id).some((e) => entries.some((x) => x.employeeId === e.id)) && (
                            <tr><td colSpan={4} style={{ color: C.muted }}>Історії ще немає — це перший період.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}

        {/* ── МІСЯЦЬ ДЛЯ ФІН. ОБЛІКУ ── */}
        {tab === "fin" && isAdmin && (
          <div style={{ display: "grid", gap: 20 }}>
            <section style={{ ...card, padding: "16px 20px" }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 21, fontWeight: 600 }}>Місяць для фін. обліку</h2>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 8 }}>
                  <button className="ghost" onClick={() => setFinMonth((m) => stepMonth(m, -1))} aria-label="Попередній місяць">←</button>
                  <span className="num" style={{ fontWeight: 600, minWidth: 150, textAlign: "center" }}>{finLabel(finMonth)}</span>
                  <button className="ghost" onClick={() => setFinMonth((m) => stepMonth(m, 1))} aria-label="Наступний місяць">→</button>
                </div>
                {finClosed && (
                  <span style={{ background: C.signalSoft, color: C.signal, borderRadius: 3, padding: "2px 8px", fontSize: 12, fontWeight: 600 }}>
                    закрито · {finClose.by}, {fmtDT(finClose.at)}
                  </span>
                )}
                <select value={finTeam} onChange={(e) => setFinTeam(e.target.value)} aria-label="Команда" style={{ width: "auto", marginLeft: "auto" }}>
                  <option value="all">Усі команди</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <button onClick={exportFin} style={{ cursor: "pointer", padding: "8px 14px", borderRadius: 3, border: "1px solid " + C.line, background: C.surface, color: C.ink2 }}>
                  Звіт в Excel
                </button>
              </div>
              <p style={{ margin: "10px 0 0", color: C.muted, fontSize: 12.5 }}>
                Дві половини зводяться пропорційно дням: 01–15 × 15/{finDays} + 16–{finDays} × {finDays - 15}/{finDays}, округлено до цілих.
                Якщо одну половину не заповнено, береться інша. Клітинку можна змінити вручну — вона підсвітиться, розрахунок видно в підказці.
              </p>
              {!finClosed && finOpen.length > 0 && (
                <p style={{ margin: "12px 0 0", background: C.warnSoft, border: "1px solid #E6CFA6", borderRadius: 3, padding: "10px 12px", color: C.warn }}>
                  Не всі періоди подано: {finOpen.map((t) => t.name + " (" + [!t.h1 && "01–15", !t.h2 && "16–" + finDays].filter(Boolean).join(", ") + ")").join("; ")}.
                </p>
              )}
              {finClosed && finDrift > 0 && (
                <p style={{ margin: "12px 0 0", background: C.warnSoft, border: "1px solid #E6CFA6", borderRadius: 3, padding: "10px 12px", color: C.warn }}>
                  Після закриття табель змінився в {finDrift} {plural(finDrift, "людини", "людей", "людей")}. У звіті лишаються зафіксовані цифри;
                  щоб перерахувати, відкрийте місяць знову.
                </p>
              )}
            </section>

            <section style={{ ...card, overflow: "hidden" }}>
              {finShown.length === 0 ? (
                <p style={{ padding: "18px 20px", margin: 0, color: C.muted }}>
                  {finClosed ? "У закритому місяці немає людей цієї команди." : "За " + finLabel(finMonth) + " даних ще немає — спершу заповніть табель у «Табель → Табель команд»."}
                </p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table>
                    <thead>
                      <tr>
                        <th style={{ minWidth: 200, position: "sticky", left: 0, background: C.surface }}>ПІБ</th>
                        <th style={{ minWidth: 140 }}>01–15</th>
                        <th style={{ minWidth: 140 }}>16–{finDays}</th>
                        {finCols.map((c) => (
                          <th key={c} style={{ minWidth: 84, textAlign: "center" }}>
                            <div>{c}</div>
                            <div className="num" style={{ fontWeight: 400, color: codes[c] ? C.muted : C.stop }}>{codes[c] || "без коду"}</div>
                          </th>
                        ))}
                        <th style={{ minWidth: 70, textAlign: "center" }}>Разом</th>
                        <th style={{ minWidth: 190 }}>Тег за місяць</th>
                        <th style={{ minWidth: 180 }}>Примітка</th>
                      </tr>
                    </thead>
                    <tbody>
                      {finShown.map((r) => {
                        const val = (list, c) => { const x = (list || []).find((y) => y.project === c); return x ? x.percent : ""; };
                        return (
                          <tr key={r.id}>
                            <td style={{ position: "sticky", left: 0, background: C.surface }}>
                              <button className="link" style={{ color: C.ink, textDecoration: "none", fontWeight: 600 }} onClick={() => setCardId(r.id)}>{r.name}</button>
                              <div style={{ color: C.muted, fontSize: 11.5 }}>{r.team || "без команди"}</div>
                              {r.miss && <div style={{ color: C.warn, fontSize: 11.5 }}>{r.miss}</div>}
                              {r.drift && <div style={{ color: C.warn, fontSize: 11.5 }}>табель змінено після закриття</div>}
                            </td>
                            <td className="num" style={{ fontSize: 12, color: r.t1 ? C.ink2 : C.muted, wordBreak: "break-all" }}>{r.t1 || "—"}</td>
                            <td className="num" style={{ fontSize: 12, color: r.t2 ? C.ink2 : C.muted, wordBreak: "break-all" }}>{r.t2 || "—"}</td>
                            {finCols.map((c) => {
                              const v = val(r.alloc, c), cv = val(r.calc, c), changed = r.manual && String(v) !== String(cv);
                              return (
                                <td key={c} style={{ padding: 4 }}>
                                  <input type="number" className="num" min="0" max="100" value={v} disabled={finClosed}
                                    title={changed ? "за розрахунком: " + (cv === "" ? 0 : cv) : undefined}
                                    onChange={(ev) => setFinCell(r, c, ev.target.value)} aria-label={r.name + ", " + c + ", за місяць"}
                                    style={{ textAlign: "center", padding: "7px 4px",
                                      background: changed ? C.warnSoft : finClosed ? "#F4F6FA" : C.surface,
                                      border: "1px solid " + (changed ? "#E6CFA6" : v !== "" ? C.line : C.lineSoft) }} />
                                </td>
                              );
                            })}
                            <td className="num" style={{ textAlign: "center", fontWeight: 600, color: r.total === 100 ? C.signal : r.total === 0 ? C.muted : C.stop }}>
                              {r.total ? r.total + "%" : "—"}
                            </td>
                            <td className="num" style={{ fontWeight: 600, color: r.tag ? C.ink : C.muted, wordBreak: "break-all", fontSize: 12.5 }}>
                              {r.tag || "—"}
                              {r.manual && (
                                <div style={{ fontWeight: 400, fontSize: 11.5, color: C.warn, wordBreak: "normal" }}>
                                  скориговано{r.by ? " · " + r.by : ""}
                                  {!finClosed && <> · <button className="link" style={{ fontSize: 11.5 }} onClick={() => resetFin(r)}>скинути</button></>}
                                </div>
                              )}
                            </td>
                            <td style={{ padding: 4 }}>
                              <input type="text" value={r.note} disabled={finClosed} placeholder={r.manual ? "чому змінено" : ""}
                                onChange={(ev) => setFinRecord(r.id, { note: ev.target.value })} aria-label={"Примітка, " + r.name} />
                            </td>
                          </tr>
                        );
                      })}
                      <tr>
                        <td style={{ position: "sticky", left: 0, background: "#F4F7FC", color: C.muted, fontWeight: 600 }}>Разом, ставок</td>
                        <td colSpan={2} style={{ background: "#F4F7FC" }} />
                        {finCols.map((c) => (
                          <td key={c} className="num" style={{ textAlign: "center", background: "#F4F7FC", color: C.ink2 }}>
                            {num2(finShown.reduce((s, r) => s + (Number((r.alloc.find((x) => x.project === c) || {}).percent) || 0) / 100, 0)) || "—"}
                          </td>
                        ))}
                        <td colSpan={3} style={{ background: "#F4F7FC" }} />
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
              <div style={{ display: "flex", gap: 10, padding: "14px 20px", borderTop: "1px solid " + C.lineSoft, flexWrap: "wrap", alignItems: "center" }}>
                {!finClosed ? (
                  <>
                    <span className="num" style={{ color: C.muted, fontSize: 12.5 }}>
                      людей: {finData.rows.filter((r) => r.alloc.length).length}
                      {" · "}скориговано: {finData.rows.filter((r) => r.manual).length}
                      {finBad.length > 0 && <span style={{ color: C.stop }}> · сума не 100%: {finBad.length}</span>}
                    </span>
                    <button style={{ ...addBtn, marginLeft: "auto" }} onClick={closeMonth}>Закрити місяць</button>
                  </>
                ) : (
                  <>
                    <span style={{ color: C.muted, fontSize: 12.5 }}>
                      Цифри зафіксовані для фін. обліку й не змінюються, навіть якщо хтось поправить табель.
                    </span>
                    <button className="link" style={{ marginLeft: "auto" }} onClick={reopenMonth}>Відкрити знову</button>
                  </>
                )}
              </div>
            </section>
          </div>
        )}

        {/* ── ЗВІТ ── */}
        {tab === "remind" && isAdmin && <Reminders getToken={() => tokenRef.current} onToast={setToast} />}

        {tab === "report" && (
          <div style={{ display: "grid", gap: 20 }}>
            <section style={{ ...card, padding: 22 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 21, fontWeight: 600 }}>Переведення по місяцях</h2>
                <div style={{ display: "flex", gap: 6 }}>
                  {years.map((y) => <button key={y} onClick={() => { setYear(y); setOpenMonth(null); }} aria-pressed={year === y} style={chip(year === y)}>{y}</button>)}
                </div>
                <span className="num" style={{ color: C.muted }}>разом за рік: {report.total}</span>
                <button onClick={exportReport} style={{ marginLeft: "auto", cursor: "pointer", padding: "8px 14px", borderRadius: 3, border: "1px solid " + C.line, background: C.surface, color: C.ink2 }}>
                  Звіт в Excel
                </button>
              </div>
              <div style={{ marginTop: 20 }}>
                {report.months.map((m) => {
                  const open = openMonth === m.key, isNow = m.key === monthKey(today);
                  return (
                    <div key={m.key} style={{ borderBottom: "1px solid " + C.lineSoft }}>
                      <button onClick={() => setOpenMonth(open ? null : m.key)} disabled={!m.count} aria-expanded={open}
                        style={{ display: "grid", gridTemplateColumns: "110px 1fr 44px", alignItems: "center", gap: 12, width: "100%",
                          textAlign: "left", background: "none", border: "none", padding: "10px 4px", cursor: m.count ? "pointer" : "default" }}>
                        <span style={{ color: isNow ? C.ink : C.ink2, fontWeight: isNow ? 600 : 400 }}>{m.label}</span>
                        <span style={{ display: "block", height: 20, background: "#EDF1F8", borderRadius: 2 }}>
                          <span style={{ display: "block", height: "100%", width: (m.count / report.max) * 100 + "%", background: isNow ? C.signal : C.plan, borderRadius: 2 }} />
                        </span>
                        <span className="num" style={{ textAlign: "right", color: m.count ? C.ink : C.line, fontWeight: 600 }}>{m.count}</span>
                      </button>
                      {open && (
                        <div style={{ padding: "4px 4px 18px" }}>
                          <p style={{ margin: "0 0 10px", color: C.muted, fontSize: 12.5 }}>
                            Подавали: {Object.entries(m.byPP).map(([k, v]) => k + " (" + v + ")").join(", ")}
                            {m.splits > 0 && " · з розподілом на кілька проєктів: " + m.splits}
                          </p>
                          <table>
                            <thead><tr><th>Співробітник</th><th>Було</th><th>Стало</th><th>Дата</th><th>Підстава</th><th>Подав</th></tr></thead>
                            <tbody>
                              {m.items.map((t) => (
                                <tr key={t.id}>
                                  <td><button className="link" style={{ color: C.ink, textDecoration: "none" }} onClick={() => setCardId(t.employeeId)}>{nameOf(t)}</button></td>
                                  <td style={{ color: C.muted }}>{allocText(t.from)}</td>
                                  <td style={{ fontWeight: 600 }}>{allocText(t.to)}</td>
                                  <td className="num" style={{ whiteSpace: "nowrap" }}>{fmt(t.effectiveDate)}</td>
                                  <td>{t.reason}</td><td>{t.partner}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="cols" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 20, alignItems: "start" }}>
              <section style={{ ...card, padding: 22 }}>
                <h2 style={{ margin: "0 0 4px", fontFamily: SERIF, fontSize: 19, fontWeight: 600 }}>Рух по проєктах за {year}</h2>
                <p style={{ margin: "0 0 14px", color: C.muted, fontSize: 12.5 }}>У ставках: людина на 50% дає 0,5.</p>
                <div style={{ overflowX: "auto" }}>
                  <table>
                    <thead><tr><th>Проєкт</th><th>Прийшло</th><th>Пішло</th><th>Нетто</th><th>Людей</th><th>Ставок</th></tr></thead>
                    <tbody>
                      {Object.keys(report.moves).sort((a, b) => a.localeCompare(b, "uk")).map((p) => {
                        const m = report.moves[p], net = m.in - m.out, h = report.heads[p] || { people: 0, fte: 0 };
                        return (
                          <tr key={p}>
                            <td>{p}</td>
                            <td className="num">{m.in ? round2(m.in) : "—"}</td>
                            <td className="num">{m.out ? round2(m.out) : "—"}</td>
                            <td className="num" style={{ fontWeight: 600, color: net > 0.001 ? C.signal : net < -0.001 ? C.stop : C.muted }}>{net > 0 ? "+" + round2(net) : round2(net)}</td>
                            <td className="num">{h.people || "—"}</td>
                            <td className="num">{h.fte ? round2(h.fte) : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <div style={{ display: "grid", gap: 20 }}>
                <section style={{ ...card, padding: 22 }}>
                  <h2 style={{ margin: "0 0 14px", fontFamily: SERIF, fontSize: 19, fontWeight: 600 }}>Хто подавав за {year}</h2>
                  {Object.keys(report.ppTotals).length === 0
                    ? <p style={{ color: C.muted, margin: 0 }}>За цей рік ще немає поданих переведень.</p>
                    : <table><thead><tr><th>People Partner</th><th>Переведень</th></tr></thead>
                        <tbody>{Object.entries(report.ppTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                          <tr key={k}><td>{k}</td><td className="num">{v}</td></tr>))}</tbody></table>}
                </section>
                <section style={{ ...card, padding: 22 }}>
                  <h2 style={{ margin: "0 0 14px", fontFamily: SERIF, fontSize: 19, fontWeight: 600 }}>Підстави за {year}</h2>
                  {Object.keys(report.reasons).length === 0
                    ? <p style={{ color: C.muted, margin: 0 }}>Даних поки немає.</p>
                    : <table><thead><tr><th>Підстава</th><th>Переведень</th></tr></thead>
                        <tbody>{Object.entries(report.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                          <tr key={k}><td>{k}</td><td className="num">{v}</td></tr>))}</tbody></table>}
                </section>
              </div>
            </div>
          </div>
        )}

        {/* ── ДОВІДНИК ── */}
        {tab === "lists" && isAdmin && (
          <div style={{ display: "grid", gap: 18 }}>
            {listNote && <p role="status" style={{ margin: 0, background: C.signalSoft, border: "1px solid #A9D5D8", borderRadius: 3, padding: "10px 14px", color: C.ink2 }}>{listNote}</p>}

            <section style={{ ...card, padding: "6px 6px 0" }}>
              <div style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
                {[["emp", "Співробітники", employees.length], ["proj", "Проєкти", allProjects.length],
                  ["pp", "People Partners", partners.length], ["reason", "Підстави", allReasons.length],
                  ["users", "Користувачі", ""], ["cfg", "Налаштування", ""]].map(([k, l, n]) => (
                  <button key={k} onClick={() => setBook(k)} aria-current={book === k}
                    style={{ cursor: "pointer", border: "none", background: book === k ? C.ink : "transparent",
                      color: book === k ? "#fff" : C.ink2, padding: "10px 16px", borderRadius: 3, marginBottom: 6,
                      fontWeight: book === k ? 600 : 400 }}>
                    {l} <span className="num" style={{ opacity: 0.7 }}>{n}</span>
                  </button>
                ))}
              </div>
            </section>

            {book === "users" && <UsersBook token={tokenRef.current} me={user} />}

            {book === "emp" && (
              <>
                {isAdmin && (
                  <section style={{ ...card, padding: 20 }}>
                    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ flex: "1 1 320px" }}>
                        <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 19, fontWeight: 600 }}>PeopleForce</h2>
                        <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 12.5 }}>
                          Щоранку підтягує нових людей, звільнення, посади й відділи. Розподіл по проєктах, команди й переведення не змінюються.
                          Звільнені зникають зі списків, але їхня історія лишається.
                        </p>
                      </div>
                      {pf && pf.configured && (
                        <button style={addBtn} disabled={pfBusy} onClick={syncPf}>{pfBusy ? "Синхронізую…" : "Синхронізувати зараз"}</button>
                      )}
                    </div>
                    {pf && !pf.configured && (
                      <p style={{ margin: "12px 0 0", background: C.warnSoft, borderRadius: 3, padding: "10px 14px", color: C.ink2, fontSize: 12.5 }}>
                        Не налаштовано. Додайте у Vercel змінну <b>PEOPLEFORCE_API_KEY</b> (PeopleForce → Налаштування → API) і <b>CRON_SECRET</b> для щоденного запуску, потім Redeploy.
                      </p>
                    )}
                    {pf && pf.configured && !pf.cron && (
                      <p style={{ margin: "12px 0 0", color: C.warn, fontSize: 12.5 }}>Щоденний запуск вимкнено: додайте у Vercel змінну CRON_SECRET (від 16 символів). Кнопка працює й без неї.</p>
                    )}
                    {pf && pf.last && (
                      <div style={{ marginTop: 12, fontSize: 12.5 }}>
                        {pf.last.ok ? (
                          <>
                            <p style={{ margin: 0, color: C.ink2 }}>
                              Востаннє: {fmtDT(pf.last.at)} ({pf.last.by}) — у PeopleForce {pf.last.total}; нових {pf.last.counts.added}, оновлено {pf.last.counts.updated}, звільнено {pf.last.counts.left}
                              {pf.last.counts.returned ? ", повернулися " + pf.last.counts.returned : ""}.
                            </p>
                            {[["Нові", pf.last.added], ["Звільнення", pf.last.left], ["Повернулися", pf.last.returned], ["Зміни", pf.last.updated]].filter(([, a]) => a && a.length).map(([l, a]) => (
                              <details key={l} style={{ marginTop: 6 }}>
                                <summary style={{ cursor: "pointer", color: C.ink2 }}>{l}: {a.length}</summary>
                                <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: C.muted }}>{a.map((x, i) => <li key={i}>{x}</li>)}</ul>
                              </details>
                            ))}
                          </>
                        ) : (
                          <p role="alert" style={{ margin: 0, color: C.stop }}>Остання спроба {fmtDT(pf.last.at)} не вдалася: {pf.last.error}</p>
                        )}
                      </div>
                    )}
                  </section>
                )}
                <section
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
                  style={{ ...card, padding: 20, borderStyle: dragOver ? "dashed" : "solid", borderColor: dragOver ? C.signal : C.line, background: dragOver ? C.signalSoft : C.surface }}>
                  <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ flex: "1 1 320px" }}>
                      <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 19, fontWeight: 600 }}>Заливка списку</h2>
                      <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 12.5 }}>
                        Перетягніть сюди Excel або CSV чи оберіть файл. Колонки розпізнаються за шапкою: ім'я одним стовпчиком
                        або «Ім'я» + «Прізвище», а також ідентифікатор, посада, проєкт і відсоток.
                      </p>
                    </div>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <button className="ghost" onClick={() => buildTemplate(allProjects, partners)}>Шаблон</button>
                      <button style={addBtn} onClick={() => fileRef.current?.click()}>Обрати файл</button>
                      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} aria-label="Файл зі списком співробітників"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
                    </div>
                  </div>

                  {importError && <p role="alert" style={{ margin: "14px 0 0", background: C.stopSoft, borderRadius: 3, padding: "12px 14px", color: C.stop }}>{importError}</p>}

                  {preview && (
                    <div style={{ marginTop: 16, background: "#F4F7FC", border: "1px solid " + C.lineSoft, borderRadius: 3, padding: "16px 18px" }}>
                      <p style={{ margin: 0, fontWeight: 600 }}>
                        «{preview.fileName}»: {preview.list.length} співробітників
                        {preview.projects.length ? ", " + preview.projects.length + " проєктів" : ""}
                        {preview.partners.length ? ", " + preview.partners.length + " People Partners" : ""}
                      </p>
                      <p style={{ margin: "6px 0 0", color: C.muted, fontSize: 12.5 }}>Колонки: {preview.head.filter(Boolean).join(" · ")}</p>
                      {preview.warnings.map((w, i) => <p key={i} style={{ margin: "8px 0 0", color: C.warn, fontSize: 12.5 }}>{w}</p>)}

                      {preview.needProject && (
                        <div style={{ marginTop: 12, background: C.surface, border: "1px solid " + C.lineSoft, borderRadius: 3, padding: "12px 14px" }}>
                          <p style={{ margin: 0, color: C.warn, fontSize: 12.5 }}>
                            Стовпчика з проєктом у файлі немає. Оберіть, звідки його брати, або зарахуйте всіх на один — далі розведете переведеннями.
                          </p>
                          <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                            <div style={{ flex: "1 1 260px" }}>
                              <label style={label} htmlFor="pcol">Проєкт брати зі стовпчика</label>
                              <select id="pcol" value={preview.projectCol} onChange={(e) => setPreview((p) => ({ ...p, projectCol: e.target.value }))}>
                                {preview.candidates.map((c) => <option key={c.i} value={String(c.i)}>{c.head} — напр. «{c.sample}»</option>)}
                                <option value="">— усіх на один проєкт —</option>
                              </select>
                            </div>
                            {preview.projectCol === "" && (
                              <div style={{ flex: "1 1 200px" }}>
                                <label style={label} htmlFor="pfall">Зарахувати всіх на</label>
                                <input id="pfall" type="text" list="projects" value={preview.fallback}
                                  onChange={(e) => setPreview((p) => ({ ...p, fallback: e.target.value }))} />
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      <p style={{ margin: "10px 0 0", color: C.muted, fontSize: 12.5 }}>
                        Вийде так: {resolveImport(preview).slice(0, 3).map((x) => x.name + (x.position ? " (" + x.position + ")" : "") + " — " + allocText(x.alloc)).join(" · ")}
                        {preview.list.length > 3 ? " …" : ""}
                      </p>

                      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
                        <button style={addBtn} onClick={() => applyImport("merge")}>Додати до довідника</button>
                        {isAdmin && <button className="ghost" onClick={() => applyImport("replace")}>Замінити весь довідник</button>}
                        <button className="ghost" onClick={() => setPreview(null)}>Скасувати</button>
                        <span style={{ color: C.muted, fontSize: 12.5 }}>Збіг за ідентифікатором або іменем оновить людину, а не створить дубль.</span>
                      </div>
                    </div>
                  )}
                </section>

                <section style={{ ...card, overflow: "hidden" }}>
                  <div style={{ padding: "14px 18px", borderBottom: "1px solid " + C.lineSoft, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <input type="text" value={empQuery} onChange={(e) => { setEmpQuery(e.target.value); setEmpShown(60); }}
                      placeholder="Пошук за іменем, посадою, ід або проєктом" aria-label="Пошук у довіднику" style={{ width: 300 }} />
                    <span className="num" style={{ color: C.muted, fontSize: 12.5 }}>
                      {bookRows.length === employees.length
                        ? employees.length + " " + plural(employees.length, "запис", "записи", "записів")
                        : "знайдено " + bookRows.length + " з " + employees.length}
                    </span>
                    {goneCount > 0 && (
                      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, color: C.ink2, cursor: "pointer" }}>
                        <input type="checkbox" checked={showGone} onChange={(e) => setShowGone(e.target.checked)} style={{ width: "auto" }} />
                        показати звільнених ({goneCount})
                      </label>
                    )}
                  </div>

                  {employees.length === 0 ? (
                    <p style={{ padding: "40px 20px", margin: 0, color: C.muted, textAlign: "center" }}>
                      Довідник порожній. Залийте файл зі списком вище — або додайте першу людину внизу.
                    </p>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table>
                        <thead><tr>
                          <th style={{ width: 44 }}>№</th>
                          {[["name", "Ім'я"], ["position", "Посада"], ["project", "Зараз на проєктах"]].map(([k, l]) => (
                            <th key={k} style={{ width: k === "name" ? 240 : k === "position" ? 230 : undefined }}>
                              <button className="link" onClick={() => setEmpSort((s2) => ({ key: k, dir: s2.key === k && s2.dir === "asc" ? "desc" : "asc" }))}
                                style={{ color: empSort.key === k ? C.ink : C.muted, textDecoration: "none", fontWeight: 600, fontSize: 12 }}>
                                {l}{empSort.key === k ? (empSort.dir === "asc" ? " ↑" : " ↓") : ""}
                              </button>
                            </th>
                          ))}
                          <th style={{ width: 160 }}>Команда</th>
                          <th style={{ width: 160 }}>Початковий проєкт</th>
                          <th style={{ width: 110 }}>Переведень</th>
                          <th style={{ width: 44 }} />
                        </tr></thead>
                        <tbody>
                          {bookRows.slice(0, empShown).map((e, i) => {
                            const n = transfersOf(e.id);
                            return (
                              <tr key={e.id}>
                                <td className="num" style={{ color: C.muted }}>{i + 1}</td>
                                <td style={e.leftOn && e.leftOn < today ? { opacity: 0.6 } : undefined}>
                                  {e.pfId
                                    ? <div style={{ fontWeight: 600 }} title="Ім'я береться з PeopleForce">{e.name}</div>
                                    : <TextCell value={e.name} aria="Ім'я співробітника" onCommit={(v) => renameEmployee(e.id, v)} />}
                                  <div style={{ color: C.muted, fontSize: 11.5, marginTop: 2 }}>
                                    {[e.extId && "ід " + e.extId, e.pfId && "PeopleForce"].filter(Boolean).join(" · ")}
                                  </div>
                                  {e.leftOn && (
                                    <div style={{ color: C.stop, fontSize: 11.5, marginTop: 2 }}>{e.leftOn < today ? "звільнено" : "звільняється"} {fmt(e.leftOn)}</div>
                                  )}
                                </td>
                                <td>
                                  {e.pfId
                                    ? <div title="Посада береться з PeopleForce">{e.position || "—"}</div>
                                    : <TextCell value={e.position || ""} placeholder="—" aria="Посада"
                                        onCommit={(v) => setEmployees((p) => p.map((x) => x.id === e.id ? { ...x, position: v, updatedAt: nowISO() } : x))} />}
                                  {(e.department || e.division) && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 2 }}>{[e.division, e.department].filter(Boolean).join(" / ")}</div>}
                                </td>
                                <td>{allocText(allocAt(e, transfers, today))}</td>
                                <td>
                                  <select value={e.teamId || ""} onChange={(ev) => joinTeam(e.id, ev.target.value)} aria-label="Команда" style={{ padding: "7px 9px" }}>
                                    <option value="">—</option>
                                    {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                                  </select>
                                </td>
                                <td>
                                  {asAlloc(e.base).length > 1
                                    ? <span style={{ fontSize: 12.5, color: C.muted }}>{allocText(asAlloc(e.base))}</span>
                                    : <select value={asAlloc(e.base)[0]?.project || ""}
                                        onChange={(ev) => setEmployees((p) => p.map((x) => x.id === e.id ? { ...x, base: ev.target.value, updatedAt: nowISO() } : x))}
                                        aria-label="Початковий проєкт" style={{ padding: "7px 9px" }}>
                                        {allProjects.filter((pr) => !offProject(pr) || pr === (asAlloc(e.base)[0] || {}).project).map((pr) => <option key={pr} value={pr}>{pr}</option>)}
                                      </select>}
                                </td>
                                <td>{n ? <button className="link" onClick={() => setCardId(e.id)}>{n} — історія</button> : <span style={{ color: C.muted }}>—</span>}</td>
                                <td>{isAdmin && <button className="del" onClick={() => removeEmployee(e.id)} title="Прибрати з довідника" aria-label={"Прибрати " + e.name}>✕</button>}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {bookRows.length > empShown && (
                        <div style={{ padding: "14px 18px", borderTop: "1px solid " + C.lineSoft, display: "flex", gap: 10, alignItems: "center" }}>
                          <button className="ghost" onClick={() => setEmpShown((n) => n + 60)}>Показати ще 60</button>
                          <button className="ghost" onClick={() => setEmpShown(bookRows.length)}>Показати всі {bookRows.length}</button>
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 10, padding: "14px 18px", borderTop: "1px solid " + C.lineSoft, flexWrap: "wrap" }}>
                    <input type="text" value={newEmp} onChange={(e) => setNewEmp(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addEmployee()}
                      placeholder="Ім'я та прізвище" aria-label="Новий співробітник" style={{ flex: "2 1 200px", width: "auto" }} />
                    <input type="text" value={newEmpPosition} onChange={(e) => setNewEmpPosition(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addEmployee()}
                      placeholder="Посада" aria-label="Посада нового співробітника" style={{ flex: "2 1 180px", width: "auto" }} />
                    <input type="text" list="projects" value={newEmpProject} onChange={(e) => setNewEmpProject(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addEmployee()}
                      placeholder="Проєкт (за замовчуванням «Бенч»)" aria-label="Проєкт нового співробітника" style={{ flex: "1 1 200px", width: "auto" }} />
                    <button onClick={addEmployee} style={addBtn}>Додати</button>
                  </div>
                </section>
              </>
            )}

            {book === "proj" && (
              <section style={{ ...card, overflow: "hidden" }}>
                <div style={{ padding: "16px 18px", borderBottom: "1px solid " + C.lineSoft }}>
                  <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 20, fontWeight: 600 }}>Проєкти</h2>
                  <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 12.5 }}>
                    Порядок у таблиці задає порядок колонок у табелі, фін. обліку, звітах і списках вибору. Неактивний проєкт
                    зникає з вибору для нових переведень, з Google Форми й з колонок табеля, але лишається в історії та звітах.
                    Код потрібен для тегів на кшталт cbx-47,cbx_pos-13,grp-40.
                  </p>
                  <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <button className="ghost" onClick={suggestCodes}>Підказати коди за назвами</button>
                    <span style={{ color: C.muted, fontSize: 12.5 }}>Доступні: {CODES.join(", ")}</span>
                  </div>
                </div>
                {allProjects.length === 0 ? (
                  <p style={{ padding: "36px 20px", margin: 0, color: C.muted, textAlign: "center" }}>Проєктів ще немає. Додайте перший унизу або залийте список співробітників — проєкти підтягнуться з файлу.</p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table>
                      <thead><tr><th style={{ width: 86 }}>Порядок</th><th>Назва</th><th style={{ width: 96 }}>Активний</th><th style={{ width: 130 }}>Код для тегів</th><th style={{ width: 190 }}>PM, який погоджує</th><th style={{ width: 80 }}>Людей</th><th style={{ width: 80 }}>Ставок</th><th style={{ width: 100 }}>Переведень</th><th style={{ width: 44 }} /></tr></thead>
                      <tbody>
                        {orderedProjects.map((p, i) => (
                          <tr key={p} style={offProject(p) ? { background: "#F4F6FA", color: C.muted } : undefined}>
                            <td style={{ whiteSpace: "nowrap" }}>
                              <span className="num" style={{ display: "inline-block", width: 20, color: C.muted, fontSize: 12 }}>{i + 1}</span>
                              <button className="del" disabled={i === 0} onClick={() => moveProject(p, -1)} aria-label="Вище" style={{ opacity: i === 0 ? 0.3 : 1 }}>↑</button>
                              <button className="del" disabled={i === orderedProjects.length - 1} onClick={() => moveProject(p, 1)} aria-label="Нижче" style={{ opacity: i === orderedProjects.length - 1 ? 0.3 : 1 }}>↓</button>
                            </td>
                            <td><TextCell value={p} aria="Назва проєкту" onCommit={(v) => renameProject(p, v)} /></td>
                            <td>
                              <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: isAdmin ? "pointer" : "default", fontSize: 12.5 }}>
                                <input type="checkbox" checked={!offProject(p)} disabled={!isAdmin} onChange={() => toggleProjectActive(p)} style={{ width: "auto" }} aria-label={"Проєкт " + p + " активний"} />
                                {offProject(p) ? "ні" : "так"}
                              </label>
                            </td>
                            <td>
                              <input type="text" list="codes" defaultValue={codes[p] || ""} placeholder="напр. cbx" aria-label={"Код проєкту " + p}
                                onBlur={(e) => { const v = e.target.value.trim().toLowerCase(); if (v !== (codes[p] || "")) setCode(p, v); }}
                                style={{ padding: "7px 9px" }} />
                            </td>
                            <td>
                              <TextCell value={pms[p] || ""} placeholder="ім'я PM" aria={"PM проєкту " + p} onCommit={(v) => setPM(p, v)} />
                            </td>
                            <td className="num">{onProject(p) || "—"}</td>
                            <td className="num">{fteOn(p) ? round2(fteOn(p)) : "—"}</td>
                            <td className="num">{usesProject(p) || "—"}</td>
                            <td>{isAdmin && <button className="del" onClick={() => removeProject(p)} title="Прибрати проєкт" aria-label={"Прибрати " + p}>✕</button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div style={{ display: "flex", gap: 10, padding: "14px 18px", borderTop: "1px solid " + C.lineSoft }}>
                  <datalist id="codes">{CODES.map((x) => <option key={x} value={x} />)}</datalist>
                  <input type="text" value={newProject} onChange={(e) => setNewProject(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addProject()}
                    placeholder="Назва проєкту" aria-label="Новий проєкт" />
                  <button onClick={addProject} style={addBtn}>Додати</button>
                </div>
              </section>
            )}

            {book === "cfg" && (
              <section style={{ ...card, padding: 22, maxWidth: 720 }}>
                <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 20, fontWeight: 600 }}>Погодження</h2>
                <p style={{ margin: "6px 0 0", color: C.ink2 }}>
                  Переведення діє з дати незалежно від погодження. Питання лише в тому, чиє підтвердження вважати обов'язковим.
                </p>
                <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
                  {[["give", "Тільки той, хто віддає людину", "PM, у якого людину забирають, підтверджує або заперечує. Той, хто приймає, бачить запис до відома."],
                    ["both", "Обидві сторони", "Підтверджують і той, хто віддає, і той, хто приймає. Довше, але жоден PM не дізнається про зміну постфактум."]].map(([k, title, desc]) => {
                    const on = settings.approvalMode === k;
                    return (
                      <button key={k} disabled={!isAdmin}
                        onClick={() => { setSettings((x) => ({ ...x, approvalMode: k })); pushLog("змінив режим погодження", title); }}
                        style={{ textAlign: "left", cursor: isAdmin ? "pointer" : "default", borderRadius: 3, padding: "14px 16px",
                          border: "1px solid " + (on ? C.signal : C.line), background: on ? C.signalSoft : C.surface }}>
                        <div style={{ fontWeight: 600, color: on ? C.signal : C.ink }}>{title}</div>
                        <div style={{ color: C.ink2, fontSize: 13, marginTop: 4 }}>{desc}</div>
                      </button>
                    );
                  })}
                </div>
                {!isAdmin && <p style={{ color: C.muted, fontSize: 12.5, marginTop: 12 }}>Змінювати може адміністратор.</p>}
                <h2 style={{ margin: "28px 0 0", fontFamily: SERIF, fontSize: 20, fontWeight: 600 }}>Команди і відповідальні</h2>
                <p style={{ margin: "6px 0 0", color: C.ink2 }}>
                  Відповідальний вносить відсотки залученості своєї команди. Люди прикріплюються у «Табель → Табель команд»
                  або колонкою «Команда» в таблиці співробітників. Ім'я відповідального має точно збігатися з іменем його
                  облікового запису у вкладці «Користувачі» — інакше він побачить порожню команду.
                  </p>
                <div style={{ overflowX: "auto", marginTop: 12 }}>
                  <table>
                    <thead><tr><th>Команда</th><th style={{ width: 220 }}>Відповідальний за %</th><th style={{ width: 90 }}>Людей</th><th style={{ width: 44 }} /></tr></thead>
                    <tbody>
                      {teams.map((t) => (
                        <tr key={t.id}>
                          <td><TextCell value={t.name} aria="Назва команди" onCommit={(v) => editTeam(t.id, (x) => ({ ...x, name: v }))} /></td>
                          <td>
                            <input type="text" list="people" defaultValue={t.owner || ""} placeholder="ім'я" aria-label={"Відповідальний за " + t.name}
                              disabled={!isAdmin} style={{ padding: "7px 9px", background: isAdmin ? C.surface : "#F1F4F9" }}
                              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (t.owner || "")) setTeamOwner(t.id, v); }} />
                          </td>
                          <td className="num">{teamMembers(t.id).length || "—"}</td>
                          <td>{isAdmin && <button className="del" onClick={() => removeTeam(t.id)} aria-label={"Прибрати " + t.name}>✕</button>}</td>
                        </tr>
                      ))}
                      {teams.length === 0 && <tr><td colSpan={4} style={{ color: C.muted, padding: 20, textAlign: "center" }}>Команд ще немає.</td></tr>}
                    </tbody>
                  </table>
                </div>
                <datalist id="people">{uniq([...partners, ...allPMs, ...employees.map((e) => e.name)]).map((n) => <option key={n} value={n} />)}</datalist>
                <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                  <input type="text" value={newTeam} onChange={(e) => setNewTeam(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTeam()}
                    placeholder="Назва нової команди" aria-label="Нова команда" style={{ flex: "1 1 240px", width: "auto" }} />
                  <button onClick={addTeam} style={addBtn}>Додати команду</button>
                </div>

                <p style={{ color: C.muted, fontSize: 12.5, marginTop: 24 }}>
                  PM призначаються у вкладці «Проєкти». Проєкт без PM нікому погоджувати — такі записи підсвічуються в «Погодженні».
                  {allProjects.filter((x) => !pms[x]).length > 0 && " Зараз без PM: " + allProjects.filter((x) => !pms[x]).length + "."}
                </p>
              </section>
            )}

            {book === "pp" && (
              <section style={{ ...card, overflow: "hidden" }}>
                <div style={{ padding: "16px 18px", borderBottom: "1px solid " + C.lineSoft }}>
                  <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 20, fontWeight: 600 }}>People Partners</h2>
                  <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 12.5 }}>
                    Список підказок для форми переведень. Це не логіни — керування обліковими записами й ролями тепер у вкладці «Користувачі».
                  </p>
                </div>
                {partners.length === 0 ? (
                  <p style={{ padding: "36px 20px", margin: 0, color: C.muted, textAlign: "center" }}>Поки що нікого. Додайте тих, хто подає переведення.</p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table>
                      <thead><tr><th>Ім'я</th><th style={{ width: 120 }}>Переведень</th><th style={{ width: 44 }} /></tr></thead>
                      <tbody>
                        {partners.map((p) => (
                          <tr key={p}>
                            <td><TextCell value={p} aria="Ім'я People Partner" onCommit={(v) => renamePartner(p, v)} /></td>
                            <td className="num">{usesPartner(p) || "—"}</td>
                            <td>{isAdmin && <button className="del" onClick={() => removePartner(p)} title="Прибрати" aria-label={"Прибрати " + p}>✕</button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div style={{ display: "flex", gap: 10, padding: "14px 18px", borderTop: "1px solid " + C.lineSoft }}>
                  <input type="text" value={newPartner} onChange={(e) => setNewPartner(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPartner()}
                    placeholder="Ім'я та прізвище" aria-label="Новий People Partner" />
                  <button onClick={addPartner} style={addBtn}>Додати</button>
                </div>
              </section>
            )}

            {book === "reason" && (
              <section style={{ ...card, overflow: "hidden" }}>
                <div style={{ padding: "16px 18px", borderBottom: "1px solid " + C.lineSoft }}>
                  <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 20, fontWeight: 600 }}>Підстави переведення</h2>
                  <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 12.5 }}>
                    Підказки у формі й розбивка у звіті. Нова підстава, вписана у форму, потрапляє сюди сама.
                  </p>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table>
                    <thead><tr><th>Підстава</th><th style={{ width: 110 }}>Використань</th><th style={{ width: 44 }} /></tr></thead>
                    <tbody>
                      {allReasons.map((r) => (
                        <tr key={r}>
                          <td><TextCell value={r} aria="Підстава переведення" onCommit={(v) => renameReason(r, v)} /></td>
                          <td className="num">{usesReason(r) || "—"}</td>
                          <td>{isAdmin && <button className="del" onClick={() => removeReason(r)} title="Прибрати підставу" aria-label={"Прибрати " + r}>✕</button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", gap: 10, padding: "14px 18px", borderTop: "1px solid " + C.lineSoft }}>
                  <input type="text" value={newReason} onChange={(e) => setNewReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addReason()}
                    placeholder="Напр. «Заміна на час відпустки»" aria-label="Нова підстава" />
                  <button onClick={addReason} style={addBtn}>Додати</button>
                </div>
              </section>
            )}
          </div>
        )}

        <p style={{ color: C.muted, fontSize: 12.5, marginTop: 18 }}>
          Дані на сервері й спільні для команди, синхронізація — раз на 60 секунд.
          Права перевіряються і в інтерфейсі, і на сервері: чуже переведення не збережеться, навіть якщо обійти інтерфейс.
        </p>
      </main>

      {/* ── КАРТКА СПІВРОБІТНИКА ── */}
      {cardEmp && (() => {
        const hist = transfers.filter((t) => t.employeeId === cardEmp.id)
          .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.createdAt.localeCompare(a.createdAt));
        const now = allocAt(cardEmp, transfers, today);
        const last = hist.filter((t) => !t.cancelled && t.effectiveDate <= today).sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
        const since = last ? daysBetween(last.effectiveDate, today) : null;
        return (
          <div onClick={() => setCardId(null)} role="dialog" aria-modal="true" aria-label={"Картка: " + cardEmp.name}
            style={{ position: "fixed", inset: 0, background: "rgba(20,30,56,.45)", display: "grid", placeItems: "center", padding: 20, zIndex: 20 }}>
            <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: "100%", maxWidth: 760, maxHeight: "86vh", overflowY: "auto" }}>
              <div style={{ padding: "20px 22px", borderBottom: "1px solid " + C.lineSoft, display: "flex", justifyContent: "space-between", gap: 14, alignItems: "flex-start" }}>
                <div>
                  <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 22, fontWeight: 600 }}>{cardEmp.name}</h2>
                  {(cardEmp.position || cardEmp.extId) && (
                    <p style={{ margin: "3px 0 0", color: C.muted, fontSize: 13 }}>
                      {cardEmp.position}{cardEmp.position && cardEmp.extId ? " · " : ""}{cardEmp.extId ? "ід " + cardEmp.extId : ""}
                    </p>
                  )}
                  <p style={{ margin: "4px 0 0", color: C.ink2 }}>
                    {allocText(now)}
                    {since !== null && <span style={{ color: C.muted }}> · так уже {since} {plural(since, "день", "дні", "днів")}</span>}
                  </p>
                  <p className="num" style={{ margin: "6px 0 0", color: C.signal, fontWeight: 600, fontSize: 13 }}>
                    {((cardEmp.teamAlloc || []).length ? tagOf(cardEmp.teamAlloc, codes) : tagOf(now, codes)) || ""}
                  </p>
                </div>
                <button className="del" onClick={() => setCardId(null)} aria-label="Закрити">✕</button>
              </div>

              <div style={{ padding: "16px 22px" }}>
                {now.map((x) => (
                  <div key={x.project} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span>{x.project}</span><span className="num" style={{ color: C.muted }}>{round2(x.percent)}%</span>
                    </div>
                    <div style={{ height: 8, background: "#EDF1F8", borderRadius: 2, marginTop: 4 }}>
                      <div style={{ height: "100%", width: x.percent + "%", background: C.signal, borderRadius: 2 }} />
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ padding: "6px 22px 22px" }}>
                <h3 style={{ margin: "0 0 12px", fontFamily: SERIF, fontSize: 17, fontWeight: 600 }}>Історія</h3>
                {hist.length === 0 ? (
                  <p style={{ color: C.muted, margin: 0 }}>Переведень ще не було. Стартовий проєкт: {allocText(asAlloc(cardEmp.base))}.</p>
                ) : hist.map((t) => {
                  const st = statusOf(t, today);
                  return (
                    <div key={t.id} style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: 14, padding: "12px 0", borderTop: "1px solid " + C.lineSoft }}>
                      <div className="num" style={{ color: C.ink2, fontWeight: 600 }}>
                        {fmt(t.effectiveDate)}
                        {t.temporary && <div style={{ fontWeight: 400, color: C.muted, fontSize: 12 }}>до {fmt(t.returnDate)}</div>}
                      </div>
                      <div>
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                          <span style={{ color: C.muted }}>{allocText(t.from)}</span>
                          <span style={{ color: C.line }}>→</span>
                          <span style={{ fontWeight: 600 }}>{allocText(t.to)}</span>
                          <span style={{ background: STATUS[st].bg, color: STATUS[st].fg, borderRadius: 3, padding: "2px 7px", fontSize: 11.5, fontWeight: 600 }}>{STATUS[st].label}</span>
                        </div>
                        <div style={{ color: C.ink2, fontSize: 13, marginTop: 4 }}>{t.reason}{t.note ? " · " + t.note : ""}</div>
                        <div style={{ color: C.muted, fontSize: 12, marginTop: 3 }}>
                          подав(ла) {t.partner || "—"} · створено {fmtDT(t.createdAt)}
                          {canCancel(t)
                            ? <>
                                <button className="link" style={{ color: C.ink2, marginLeft: 10 }} onClick={() => { setCardId(null); openEdit(t); }}>змінити</button>
                                <button className="link" style={{ color: C.ink2, marginLeft: 10 }} onClick={() => toggleCancel(t)}>{t.cancelled ? "відновити" : "скасувати"}</button>
                              </>
                            : <span style={{ marginLeft: 10 }} title="Чужий запис">🔒</span>}
                        {t.editedBy && <div style={{ color: C.warn, fontSize: 12, marginTop: 2 }}>змінив(ла) {t.editedBy}, {fmtDT(t.editedAt)}</div>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ padding: "0 22px 22px" }}>
                <button style={{ ...addBtn, background: C.signal, fontWeight: 600 }}
                  onClick={() => { setSelectedId(cardEmp.id); resetDist(); setErrors([]); setTab("form"); setCardId(null); }}>
                  Створити переведення
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── РЕДАГУВАННЯ ЗАПИСУ ── */}
      {edit && editId && (() => {
        const t = transfers.find((x) => x.id === editId);
        if (!t) return null;
        return (
          <div onClick={() => { setEditId(null); setEdit(null); }} role="dialog" aria-modal="true" aria-label="Редагування переведення"
            style={{ position: "fixed", inset: 0, background: "rgba(20,30,56,.45)", display: "grid", placeItems: "center", padding: 20, zIndex: 25 }}>
            <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: "100%", maxWidth: 620, maxHeight: "88vh", overflowY: "auto" }}>
              <div style={{ padding: "20px 22px", borderBottom: "1px solid " + C.lineSoft }}>
                <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 21, fontWeight: 600 }}>Змінити переведення</h2>
                <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 12.5 }}>
                  {nameOf(t)} · подано {fmtDT(t.createdAt)} · «Було: {allocText(t.from)}» лишається як у момент подання.
                </p>
              </div>

              <div style={{ padding: "18px 22px" }}>
                <span style={label}>Розподіл після переведення</span>
                <div style={{ display: "grid", gap: 8 }}>
                  {edit.dist.map((r, i) => (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 92px 30px", gap: 6, alignItems: "center" }}>
                      <input type="text" list="projects" value={r.project} onChange={(ev) => setEditRow(i, { project: ev.target.value })}
                        placeholder="проєкт" aria-label={"Проєкт " + (i + 1)} />
                      <div style={{ position: "relative" }}>
                        <input type="number" className="num" min="0" max="100" value={r.percent}
                          onChange={(ev) => setEditRow(i, { percent: ev.target.value === "" ? "" : Number(ev.target.value) })}
                          aria-label={"Відсоток " + (i + 1)} style={{ paddingRight: 26, textAlign: "right" }} />
                        <span style={{ position: "absolute", right: 9, top: 10, color: C.muted, pointerEvents: "none" }}>%</span>
                      </div>
                      {edit.dist.length > 1 ? <button className="del" onClick={() => dropEditRow(i)} aria-label="Прибрати рядок">✕</button> : <span />}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                  <button className="ghost" onClick={addEditRow}>+ Ще один проєкт</button>
                  <span className="num" style={{ marginLeft: "auto", fontWeight: 600, color: editTotal === 100 ? C.signal : C.stop }}>
                    {editTotal === 100 ? "разом 100%" : "разом " + round2(editTotal) + "%"}
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14, marginTop: 18 }}>
                  <div>
                    <label style={label} htmlFor="eeff">Дата переведення</label>
                    <input id="eeff" type="date" value={edit.effectiveDate} onChange={(e) => setEdit((d) => ({ ...d, effectiveDate: e.target.value }))} />
                  </div>
                  <div>
                    <span style={label}>Тип</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => setEdit((d) => ({ ...d, temporary: false }))} style={{ ...chip(!edit.temporary), flex: 1, padding: "9px 10px" }}>Постійне</button>
                      <button onClick={() => setEdit((d) => ({ ...d, temporary: true }))} style={{ ...chip(edit.temporary), flex: 1, padding: "9px 10px" }}>Тимчасове</button>
                    </div>
                  </div>
                  <div>
                    <label style={{ ...label, color: edit.temporary ? C.muted : C.line }} htmlFor="eret">Повернення</label>
                    <input id="eret" type="date" value={edit.returnDate} disabled={!edit.temporary}
                      onChange={(e) => setEdit((d) => ({ ...d, returnDate: e.target.value }))}
                      style={{ background: edit.temporary ? C.surface : "#F1F4F9", color: edit.temporary ? C.ink : C.muted }} />
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginTop: 14 }}>
                  <div>
                    <label style={label} htmlFor="ereason">Підстава</label>
                    <input id="ereason" type="text" list="reasons" value={edit.reason} onChange={(e) => setEdit((d) => ({ ...d, reason: e.target.value }))} />
                  </div>
                  <div>
                    <label style={label} htmlFor="enote">Коментар</label>
                    <input id="enote" type="text" value={edit.note} onChange={(e) => setEdit((d) => ({ ...d, note: e.target.value }))} placeholder="необов'язково" />
                  </div>
                </div>

                {editErrors.length > 0 && (
                  <div role="alert" style={{ marginTop: 14, background: C.stopSoft, border: "1px solid #E2BCC6", borderRadius: 3, padding: "12px 14px", color: C.stop }}>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>{editErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                  </div>
                )}

                <div style={{ display: "flex", gap: 12, marginTop: 20, flexWrap: "wrap", alignItems: "center" }}>
                  <button onClick={saveEdit} style={{ ...addBtn, background: C.signal, fontWeight: 600, padding: "12px 22px" }}>Зберегти зміни</button>
                  <button className="ghost" onClick={() => { setEditId(null); setEdit(null); }}>Скасувати</button>
                  <span style={{ color: C.muted, fontSize: 12.5 }}>Правку буде видно в журналі й підписано вашим ім'ям.</span>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {toast && (
        <div role="status" style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 24,
          background: C.ink, color: "#fff", padding: "12px 18px", borderRadius: 4, boxShadow: "0 8px 24px rgba(20,30,56,.24)", maxWidth: "90vw", zIndex: 30 }}>{toast}</div>
      )}
    </div>
  );
}

/* ─── КОРИСТУВАЧІ (лише адміністратор) ──────────────────────────────────
Облікові записи живуть окремо від спільного стану: паролі зберігаються
на сервері у вигляді хешу й ніколи не потрапляють у /api/state. Ім'я тут
має точно збігатися з «Відповідальний за %» у команді — за ним сервер
вирішує, яку команду людина бачить. ───────────────────────────────────── */
function UsersBook({ token, me }) {
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState(null);
  const [form, setForm] = useState({ username: "", displayName: "", password: "", role: "owner" });

  const card = { background: C.surface, border: "1px solid " + C.line, borderRadius: 4 };
  const label = { fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 6, display: "block" };
  const addBtn = { cursor: "pointer", background: C.ink, color: "#fff", border: "none", borderRadius: 3, padding: "9px 16px", whiteSpace: "nowrap" };

  async function call(method, body, query) {
    const res = await fetch("/api/admin/users" + (query || ""), {
      method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }
  async function load() {
    setBusy(true);
    setError("");
    try {
      setUsers((await call("GET")).users || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function create() {
    setError("");
    setSecret(null);
    try {
      const d = await call("POST", form);
      setSecret({ username: d.user.username, displayName: d.user.displayName, password: d.password });
      setForm({ username: "", displayName: "", password: "", role: "owner" });
      load();
    } catch (e) {
      setError(e.message);
    }
  }
  async function patch(username, body, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setError("");
    setSecret(null);
    try {
      const d = await call("PATCH", { username, ...body });
      if (d.password) setSecret({ username: d.user.username, displayName: d.user.displayName, password: d.password });
      load();
    } catch (e) {
      setError(e.message);
    }
  }
  async function remove(u) {
    if (!window.confirm("Видалити обліковий запис «" + u.displayName + "» (" + u.username + ")? Увійти під ним більше не вийде.")) return;
    setError("");
    setSecret(null);
    try {
      await call("DELETE", null, "?username=" + encodeURIComponent(u.username));
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <section style={{ ...card, overflow: "hidden" }}>
      <div style={{ padding: "16px 18px", borderBottom: "1px solid " + C.lineSoft }}>
        <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 20, fontWeight: 600 }}>Користувачі й ролі</h2>
        <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 12.5 }}>
          <b>Адміністратор</b> бачить і править усе. <b>HRD</b> веде табель своєї команди й проводить переведення (правити може лише свої).{" "}
          <b>Відповідальний</b> бачить лише команду, де його ім'я стоїть у полі «Відповідальний за %» (Довідник → Налаштування),
          вносить відсотки й подає період. Чужі команди сервер їм не віддає.
        </p>
      </div>

      {error && (
        <p role="alert" style={{ margin: "14px 18px 0", background: C.stopSoft, borderRadius: 3, padding: "10px 12px", color: C.stop }}>
          {error}
        </p>
      )}
      {secret && (
        <div
          role="status"
          style={{ margin: "14px 18px 0", background: C.warnSoft, border: "1px solid #E6CFA6", borderRadius: 3, padding: "12px 14px", color: C.ink }}
        >
          <div style={{ fontWeight: 600 }}>Пароль для {secret.displayName}</div>
          <div className="num" style={{ marginTop: 6, fontSize: 15 }}>
            логін: <b>{secret.username}</b> · пароль: <b style={{ userSelect: "all" }}>{secret.password}</b>
          </div>
          <div style={{ color: C.warn, fontSize: 12.5, marginTop: 6 }}>
            Скопіюйте й передайте людині особисто. Після закриття цієї вкладки пароль більше ніде не побачити — лише скинути.
          </div>
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Логін</th>
              <th>Ім'я (як у «Відповідальний за %»)</th>
              <th style={{ width: 190 }}>Роль</th>
              <th style={{ width: 240 }} />
            </tr>
          </thead>
          <tbody>
            {busy && !users.length && (
              <tr>
                <td colSpan={4} style={{ color: C.muted }}>
                  Завантажуємо…
                </td>
              </tr>
            )}
            {!busy && !users.length && (
              <tr>
                <td colSpan={4} style={{ color: C.muted }}>
                  Облікових записів ще немає.
                </td>
              </tr>
            )}
            {users.map((u) => {
              const self = me && me.username === u.username;
              return (
                <tr key={u.username}>
                  <td className="num">
                    {u.username}
                    {self && <span style={{ color: C.muted }}> (ви)</span>}
                  </td>
                  <td>
                    <TextCell value={u.displayName} aria={"Ім'я " + u.username} onCommit={(v) => patch(u.username, { displayName: v })} />
                  </td>
                  <td>
                    <select
                      value={roleOf(u)}
                      disabled={self}
                      title={self ? "Власну роль змінює інший адміністратор" : "Змінити роль"}
                      aria-label={"Роль " + u.displayName}
                      onChange={(e) => {
                        const r = e.target.value;
                        patch(u.username, { role: r }, "Змінити роль «" + u.displayName + "» на «" + ROLE_LABEL[r] + "»?" +
                          (r === "admin" ? " Адміністратор бачить і править усе." : r === "hrd" ? " HRD проводитиме переведення й вестиме табель своєї команди." : ""));
                      }}
                      style={{ padding: "6px 8px", minWidth: 170 }}
                    >
                      <option value="owner">відповідальний</option>
                      <option value="hrd">HRD</option>
                      <option value="admin">адміністратор</option>
                    </select>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      className="link"
                      style={{ marginRight: 14 }}
                      onClick={() =>
                        patch(u.username, { resetPassword: true }, "Згенерувати новий пароль для «" + u.displayName + "»? Старий перестане діяти.")
                      }
                    >
                      Скинути пароль
                    </button>
                    {!self && (
                      <button className="link" style={{ color: C.stop }} onClick={() => remove(u)}>
                        Видалити
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ padding: "16px 18px", borderTop: "1px solid " + C.lineSoft, background: "#F7F9FC" }}>
        <h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 600 }}>Додати користувача</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, alignItems: "end" }}>
          <div>
            <label style={label} htmlFor="nu-login">
              Логін
            </label>
            <input
              id="nu-login"
              type="text"
              value={form.username}
              placeholder="напр. taras.mamai"
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            />
          </div>
          <div>
            <label style={label} htmlFor="nu-name">
              Ім'я та прізвище
            </label>
            <input
              id="nu-name"
              type="text"
              value={form.displayName}
              placeholder="Тарас Мамай"
              onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
            />
          </div>
          <div>
            <label style={label} htmlFor="nu-pwd">
              Пароль (порожньо — згенерувати)
            </label>
            <input
              id="nu-pwd"
              type="text"
              value={form.password}
              placeholder="щонайменше 8 символів"
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </div>
          <div>
            <label style={label} htmlFor="nu-role">
              Роль
            </label>
            <select id="nu-role" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} style={{ marginBottom: 8 }}>
              <option value="owner">відповідальний</option>
              <option value="hrd">HRD</option>
              <option value="admin">адміністратор</option>
            </select>
            <button style={{ ...addBtn, width: "100%" }} onClick={create}>
              Створити
            </button>
          </div>
        </div>
        <p style={{ margin: "10px 0 0", color: C.muted, fontSize: 12.5 }}>
          Логін — латиницею, 3–32 символи (літери, цифри, крапка, дефіс, підкреслення). Щоб відповідальний побачив команду, впишіть це саме ім'я в
          «Довідник → Налаштування → Відповідальний за %».
        </p>
      </div>
    </section>
  );
}
