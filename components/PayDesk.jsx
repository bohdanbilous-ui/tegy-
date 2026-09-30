"use client";
/* Відомості ЗП: теги для зарплати всіх людей, окремі відомості на кожну
   пару «юрособа × Штат/Гіг» і вивантаження в Google Таблицю.
   Звідки береться розподіл людини (за порядком):
     1) «тег як у …» — брати результат іншої людини;
     2) табель / звіт годин / коригування фін. обліку за період;
     3) фіксований розподіл (вручну або з файлу);
     4) розподіл за довідником і переведеннями.
   FPV — окремий довідник людей поза PeopleForce; за замовчуванням fpv-100. */
import React, { useState, useEffect, useMemo, useRef } from "react";
import * as XLSX from "xlsx";

const C = {
  paper: "#E7ECF4", surface: "#FFFFFF", ink: "#141E38", ink2: "#37456A",
  muted: "#6F7B99", line: "#C2CDE1", lineSoft: "#DFE5F0",
  signal: "#0C7480", signalSoft: "#DBEFF0", plan: "#33489E", planSoft: "#E1E6F8",
  warn: "#8A5510", warnSoft: "#F8EBD6", stop: "#8A2E44", stopSoft: "#F6E2E7",
};
const SERIF = '"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif';
const MONTHS = ["Січень","Лютий","Березень","Квітень","Травень","Червень","Липень","Серпень","Вересень","Жовтень","Листопад","Грудень"];
const MONTHS_GEN = ["січня","лютого","березня","квітня","травня","червня","липня","серпня","вересня","жовтня","листопада","грудня"];
const pad = (n) => String(n).padStart(2, "0");
const lastDay = (y, m) => new Date(y, m, 0).getDate();
const plural = (n, a, b, c) => { const m = n % 100; if (m > 10 && m < 20) return c; const k = n % 10; return k === 1 ? a : k > 1 && k < 5 ? b : c; };
const low = (s) => String(s || "").trim().toLowerCase();

export const DEFAULT_TPL = {
  staff: "Виплата заробітної плати за {половину} {місяця} {рік} року. Податки сплачено згідно пільг за наявності статусу резидента Дія.Сіті {тег}",
  gig: "Оплата винагороди згідно укладеного гіг-контракту за {мм}/{рік}. Податки сплачено повністю з пільгами згідно статусу резидента Дія.Сіті {тег}",
};
const TYPE_KEY = { "Штат": "staff", "Гіг": "gig" };

/* «cbx-80, cbx_pos-15» → [{ code, pct }]. */
export function parseFixed(str) {
  const parts = [], bad = [];
  String(str || "").replace(/[{}]/g, "").replace(/^prd:/i, "").split(/[,;]+/).map((x) => x.trim()).filter(Boolean).forEach((tok) => {
    const m = tok.match(/^([a-z_]+)\s*[-:\s]\s*(\d+(?:[.,]\d+)?)\s*%?$/i);
    if (!m) { bad.push(tok); return; }
    const code = m[1].toLowerCase(), pct = Number(m[2].replace(",", "."));
    const same = parts.find((p) => p.code === code);
    if (same) same.pct += pct; else parts.push({ code, pct });
  });
  return { parts: parts.filter((p) => p.pct > 0), bad };
}
const partsText = (parts) => parts.map((p) => p.code + "-" + p.pct).join(",");
const nameWords = (s) => low(s).replace(/[ʼ'’`]/g, "").replace(/[^a-zа-яіїєґ\s-]+/gi, " ").split(/[\s-]+/).filter((w) => w.length > 1);

function fillTpl(tpl, v) {
  return String(tpl || "")
    .replace(/\{половину\}/g, v.half === 1 ? "першу половину" : v.half === 2 ? "другу половину" : "")
    .replace(/\{половина\}/g, v.half === 1 ? "перша половина" : v.half === 2 ? "друга половина" : "")
    .replace(/\{місяця\}/g, MONTHS_GEN[v.m - 1]).replace(/\{місяць\}/g, MONTHS[v.m - 1].toLowerCase())
    .replace(/\{мм\}/g, pad(v.m)).replace(/\{рік\}/g, String(v.y))
    .replace(/\{ПІБ\}/g, v.name || "").replace(/\{тег\}/g, v.tag || "")
    .replace(/\s{2,}/g, " ").trim();
}

export default function PayDesk({ employees, setEmployees, fpv, setFpv, settings, setSettings, codes, codeList, spanCalculator, toParts,
  token, setToast, pushLog, stamp, today, openCard, canEdit = true }) {
  // canEdit=false — лише перегляд (зараз і адміністратор, і бухгалтер мають повні права у відомостях).
  const pay = settings.pay || {};
  const tpl = { ...DEFAULT_TPL, ...(pay.tpl || {}) };
  const staffSpan = pay.staffSpan || "half", gigSpan = pay.gigSpan || "month";
  const setPay = (patch) => setSettings((st) => ({ ...st, pay: { ...(st.pay || {}), ...patch } }));

  const [per, setPer] = useState(() => ({ y: +today.slice(0, 4), m: +today.slice(5, 7), half: +today.slice(8, 10) <= 15 ? 1 : 2 }));
  const [inn, setInn] = useState({});
  const [shownInn, setShownInn] = useState({});
  const [sheetReady, setSheetReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(80);
  const [showTpl, setShowTpl] = useState(false);
  const [sent, setSent] = useState(null);
  const [imp, setImp] = useState(null);
  const [newFpv, setNewFpv] = useState("");
  const fileRef = useRef(null);

  async function callPay(method, body, qs) {
    const res = await fetch("/api/pay" + (qs || ""), {
      method, cache: "no-store",
      headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "HTTP " + res.status);
    return d;
  }
  useEffect(() => {
    callPay("GET").then((d) => { setInn(d.inn || {}); setSheetReady(!!d.ready); }).catch(() => {});
  }, [token]);

  const spanOf = (which) => {
    const mk = per.y + "-" + pad(per.m), end = mk + "-" + pad(lastDay(per.y, per.m));
    if (which === "month") return { from: mk + "-01", to: end, half: 0 };
    return per.half === 1 ? { from: mk + "-01", to: mk + "-15", half: 1 } : { from: mk + "-16", to: end, half: 2 };
  };
  const spans = { staff: spanOf(staffSpan), gig: spanOf(gigSpan) };
  const knownCodes = useMemo(() => new Set([...(codeList || []), ...Object.values(codes || {}).filter(Boolean)]), [codeList, codes]);
  // Довідник юросіб: з нього в кожному рядку обирається юрособа.
  const legalBook = useMemo(() => (pay.legals || []).map((x) => (typeof x === "string" ? { name: x } : { name: x.name || "" })).filter((x) => x.name),
    [pay.legals]);
  const legalNames = legalBook.map((x) => x.name);
  const setLegalBook = (list) => setPay({ legals: list });

  /* ─── розрахунок рядків відомостей ─── */
  const rows = useMemo(() => {
    const calcs = { staff: spanCalculator(spans.staff.from, spans.staff.to), gig: spanCalculator(spans.gig.from, spans.gig.to) };
    const list = [];
    employees.forEach((e) => {
      const type = e.payType || e.fileType || "";
      const sp = spans[TYPE_KEY[type] || "staff"];
      if (e.hiredOn && e.hiredOn > sp.to) return;
      if (e.leftOn && e.leftOn < sp.from) return;
      const calc = calcs[TYPE_KEY[type] || "staff"](e);
      const fixedStr = e.payFixed || e.fileFixed || "";
      let parts, source, notes = calc.notes;
      if (calc.kind === "облік" || calc.kind === "змішано") { parts = toParts(calc.alloc); source = "табель"; }
      else if (fixedStr) { parts = parseFixed(fixedStr).parts.map((p) => ({ ...p, project: p.code })); source = e.payFixed ? "фікс." : "фікс. з файлу"; notes = []; }
      else { parts = toParts(calc.alloc); source = calc.kind === "довідник" ? "довідник" : "—"; }
      list.push({
        id: e.id, kind: "emp", name: e.pfFio || e.name, short: e.name, type,
        typeAuto: e.fileType || "",
        legal: e.payLegal || "",
        like: e.payLike || "", off: !!e.payOff, fixed: e.payFixed || "", fileFixed: e.fileFixed || "",
        parts, source, notes, sp,
      });
    });
    (fpv || []).filter((f) => f.active !== false).forEach((f) => {
      const type = f.type || "Гіг";
      const sp = spans[TYPE_KEY[type] || "gig"];
      const { parts } = parseFixed(f.fixed || "fpv-100");
      list.push({ id: f.id, kind: "fpv", name: f.name, short: f.name, type, typeAuto: "", legal: f.legal || "",
        like: "", off: false, fixed: f.fixed || "fpv-100", fileFixed: "", parts: parts.map((p) => ({ ...p, project: p.code })), source: "FPV", notes: [], sp });
    });
    const byId = new Map(list.map((r) => [r.id, r]));
    list.forEach((r) => {
      if (!r.like) return;
      const t = byId.get(r.like);
      if (t && t.id !== r.id) { r.parts = t.parts; r.source = "як у " + t.short; r.notes = []; }
      else r.source = "як у — людину не знайдено";
    });
    list.forEach((r) => {
      const sum = Math.round(r.parts.reduce((a, p) => a + p.pct, 0) * 100) / 100;
      const noCode = r.parts.filter((p) => !p.code).map((p) => p.project);
      const badCode = r.parts.filter((p) => p.code && !knownCodes.has(p.code)).map((p) => p.code);
      const prob = [];
      if (!r.type) prob.push("немає типу Штат/Гіг");
      if (!r.parts.length) prob.push("немає розподілу");
      if (noCode.length) prob.push("без коду: " + noCode.join(", "));
      if (badCode.length) prob.push("невідомий код: " + badCode.join(", "));
      if (r.parts.length && !noCode.length && sum !== 100) prob.push("сума " + sum + "%");
      if (!inn[r.id]) prob.push("немає ІПН");
      if (!r.legal) prob.push("немає юрособи");
      else if (legalBook.length && !legalNames.includes(r.legal)) prob.push("юрособи «" + r.legal + "» немає в довіднику");
      r.tagBody = r.parts.filter((p) => p.code).map((p) => p.code + "-" + p.pct).join(",");
      r.tag = r.tagBody ? "{prd:" + r.tagBody + "}" : "";
      r.problems = prob;
      r.key = (r.legal || "без юрособи") + " · " + (r.type || "без типу");
      r.purpose = r.tag ? fillTpl(tpl[TYPE_KEY[r.type] || "staff"], { half: r.sp.half, m: per.m, y: per.y, name: r.name, tag: r.tag }) : "";
    });
    return list.sort((a, b) => a.name.localeCompare(b.name, "uk"));
  }, [employees, fpv, per.y, per.m, per.half, staffSpan, gigSpan, codes, inn, knownCodes, tpl.staff, tpl.gig, spanCalculator, toParts, legalBook]);

  const included = rows.filter((r) => !r.off);
  const statements = useMemo(() => {
    const m = new Map();
    included.forEach((r) => { if (!m.has(r.key)) m.set(r.key, { key: r.key, legal: r.legal, type: r.type, rows: [], bad: 0 }); const s = m.get(r.key); s.rows.push(r); if (r.problems.length) s.bad++; });
    return [...m.values()].sort((a, b) => (a.type || "я").localeCompare(b.type || "я", "uk") || (a.legal || "я").localeCompare(b.legal || "я", "uk"));
  }, [included]);
  const q = low(query);
  const visible = rows.filter((r) => (view === "all" ? true : view === "bad" ? !r.off && r.problems.length : view === "off" ? r.off : view === "fpv" ? r.kind === "fpv" : !r.off && r.key === view)
    && (!q || low(r.name).includes(q) || low(r.short).includes(q) || low(r.tagBody).includes(q)));
  const badCount = included.filter((r) => r.problems.length).length;
  const perLabel = MONTHS[per.m - 1] + " " + per.y;
  const spanText = (w) => (w === "month" ? "місяць" : per.half === 1 ? "01–15" : "16–" + lastDay(per.y, per.m));

  /* ─── правки ─── */
  const setEmp = (id, patch) => setEmployees((p) => p.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: stamp() } : x)));
  const setF = (id, patch) => setFpv((p) => p.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: stamp() } : x)));
  const edit = (r, patch) => (r.kind === "fpv" ? setF(r.id, patch) : setEmp(r.id, patch));
  const likeId = (name) => { const n = low(name); if (!n) return ""; const r = rows.find((x) => low(x.name) === n || low(x.short) === n); return r ? r.id : null; };

  async function revealInn(r) {
    if (shownInn[r.id]) return setShownInn((m) => { const n = { ...m }; delete n[r.id]; return n; });
    try { const d = await callPay("GET", null, "?id=" + encodeURIComponent(r.id)); setShownInn((m) => ({ ...m, [r.id]: d.inn || "—" })); }
    catch (e) { setToast("Не вдалося показати ІПН: " + e.message); }
  }
  async function askInn(r) {
    const v = window.prompt("ІПН для «" + r.name + "»" + (inn[r.id] ? " (зараз " + inn[r.id].m + ")" : "") + ".\nПорожньо — прибрати.", "");
    if (v === null) return;
    try {
      const d = await callPay("POST", { action: "inn", items: [{ id: r.id, inn: v.trim() }] });
      setInn(d.inn || {});
      setToast(d.bad ? "ІПН не збережено: має бути 8–12 цифр або літер." : v.trim() ? "ІПН збережено." : "ІПН прибрано.");
    } catch (e) { setToast("Не вдалося зберегти ІПН: " + e.message); }
  }

  function addFpv() {
    const name = newFpv.trim();
    if (!name) return;
    if ((fpv || []).some((f) => low(f.name) === low(name))) return setToast("«" + name + "» уже є в довіднику FPV.");
    setFpv((p) => [...(p || []), { id: "fv" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, type: "Штат", legal: "", fixed: "fpv-100", note: "", active: true, updatedAt: stamp() }]);
    setNewFpv("");
    pushLog("додав людину в довідник FPV", name);
  }

  /* ─── імпорт з таблиці «Теги ЗП» (аркуш «Співробітники») ─── */
  async function readFile(file) {
    try {
      const wb = /\.csv$/i.test(file.name) ? XLSX.read(await file.text(), { type: "string" }) : XLSX.read(await file.arrayBuffer(), { type: "array" });
      let best = null;
      for (const n of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: "", raw: false });
        const hi = aoa.findIndex((r) => r.some((c) => /піб|прізвище|співробітник/i.test(String(c))) && r.some((c) => /розподіл|іпн|штат/i.test(String(c))));
        if (hi >= 0) { best = { name: n, head: aoa[hi].map(String), body: aoa.slice(hi + 1) }; if (/співробітник/i.test(n)) break; }
      }
      if (!best) return setToast("Не знайшов аркуша з колонками ПІБ, ІПН, Штат/Гіг і розподілом. Вивантажте аркуш «Співробітники».");
      const col = (re) => best.head.findIndex((h) => re.test(h));
      const cName = col(/піб|прізвище|співробітник/i), cInn = col(/іпн|рнокпп/i), cType = col(/штат|гіг|тип/i),
        cFix = col(/розподіл|тег/i), cNote = col(/примітк/i), cLegal = col(/юрособ|юр\.|компан|фоп|тов/i);
      const items = best.body.map((r) => ({
        name: String(r[cName] || "").trim(), inn: cInn >= 0 ? String(r[cInn] || "").trim() : "",
        type: cType >= 0 ? (/гіг/i.test(r[cType]) ? "Гіг" : /штат/i.test(r[cType]) ? "Штат" : "") : "",
        fixed: cFix >= 0 ? String(r[cFix] || "").trim() : "", note: cNote >= 0 ? String(r[cNote] || "").trim() : "",
        legal: cLegal >= 0 ? String(r[cLegal] || "").trim() : "",
      })).filter((x) => x.name);
      const isFpv = (x) => { const p = parseFixed(x.fixed).parts; return p.length > 0 && p.every((y) => y.code === "fpv"); };
      const words = employees.map((e) => ({ e, w: nameWords(e.name), f: low(e.pfFio) }));
      const findEmp = (name) => {
        const fw = nameWords(name);
        const hits = words.filter((x) => (x.f && x.f === low(name)) || (x.w.length > 1 && x.w.every((w) => fw.includes(w))));
        return hits.length === 1 ? hits[0].e : null;
      };
      const fp = [], emp = [], lost = [];
      items.forEach((x) => {
        if (isFpv(x)) fp.push({ ...x, old: (fpv || []).find((f) => low(f.name) === low(x.name)) || null });
        else { const e = findEmp(x.name); if (e) emp.push({ ...x, e }); else lost.push(x); }
      });
      setImp({ file: file.name, sheet: best.name, fp, emp, lost, withEmp: true, withInn: true });
    } catch (err) {
      setToast("Не вдалося прочитати файл: " + ((err && err.message) || "невідомий формат"));
    }
  }
  async function applyImport() {
    if (!imp) return;
    const now = stamp();
    const fpvIds = new Map();
    const next = [...(fpv || [])];
    imp.fp.forEach((x) => {
      const i = next.findIndex((f) => low(f.name) === low(x.name));
      const rec = { name: x.name, type: x.type || "Штат", fixed: parseFixed(x.fixed).parts.length ? x.fixed : "fpv-100", note: x.note, ...(x.legal ? { legal: x.legal } : {}), active: true, updatedAt: now };
      if (i >= 0) { next[i] = { ...next[i], ...rec }; fpvIds.set(x.name, next[i].id); }
      else { const id = "fv" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); next.push({ id, legal: "", ...rec }); fpvIds.set(x.name, id); }
    });
    setFpv(next);
    if (imp.withEmp) {
      const byId = new Map(imp.emp.map((x) => [x.e.id, x]));
      setEmployees((p) => p.map((e) => {
        const x = byId.get(e.id);
        if (!x) return e;
        return { ...e, fileFixed: parseFixed(x.fixed).parts.length ? x.fixed : e.fileFixed || "", fileType: x.type || e.fileType || "", updatedAt: now };
      }));
    }
    const innItems = [
      ...imp.fp.filter((x) => x.inn).map((x) => ({ id: fpvIds.get(x.name), inn: x.inn })),
      ...(imp.withInn ? imp.emp.filter((x) => x.inn).map((x) => ({ id: x.e.id, inn: x.inn })) : []),
    ].filter((x) => x.id);
    try {
      if (innItems.length) { const d = await callPay("POST", { action: "inn", items: innItems }); setInn(d.inn || {}); }
      setToast("Імпортовано: FPV " + imp.fp.length + (imp.withEmp ? ", співробітників " + imp.emp.length : "") + (innItems.length ? ", ІПН " + innItems.length : "") + ".");
      pushLog("імпортував дані для відомостей ЗП", imp.file + " · FPV " + imp.fp.length + ", співробітників " + imp.emp.length);
      setImp(null);
    } catch (e) { setToast("Люди імпортовані, але ІПН не збережено: " + e.message); }
  }

  /* ─── у Google Таблицю ─── */
  async function send() {
    if (!statements.length) return setToast("Немає кого вивантажувати за " + perLabel + ".");
    const msg = "Записати в Google Таблицю " + statements.length + " " + plural(statements.length, "відомість", "відомості", "відомостей") + " за " + perLabel +
      " (" + included.length + " " + plural(included.length, "людина", "людини", "людей") + ")?" +
      (badCount ? "\n\nУ " + badCount + " " + plural(badCount, "рядку", "рядках", "рядках") + " є проблеми — вони підуть зі статусом, щоб їх було видно в таблиці." : "") +
      "\n\nВкладки цих відомостей у таблиці буде повністю перезаписано.";
    if (!window.confirm(msg)) return;
    const header = ["№", "ПІБ", "ІПН", "Тип", "Юрособа", "Розподіл", "Тег", "Призначення платежу", "Джерело", "Статус"];
    const tabs = statements.map((s) => ({
      name: (s.type || "без типу") + " · " + (s.legal || "без юрособи"),
      header,
      rows: s.rows.map((r, i) => ({ id: r.id, cells: [i + 1, r.name, "{{ІПН}}", r.type, r.legal, r.tagBody, r.tag, r.purpose, r.source, r.problems.length ? r.problems.join("; ") : "OK"] })),
    }));
    setBusy(true);
    try {
      const d = await callPay("POST", { action: "send", period: perLabel + " · Штат: " + spanText(staffSpan) + " · Гіг: " + spanText(gigSpan), tabs });
      setSent({ at: new Date().toISOString(), ...d, count: included.length, bad: badCount });
      setToast("Записано: " + d.tabs + " " + plural(d.tabs, "відомість", "відомості", "відомостей") + (d.noInn ? " · без ІПН: " + d.noInn : "") + ".");
      pushLog("вивантажив відомості ЗП у Google Таблицю", perLabel + " · " + statements.length + " відомостей, " + included.length + " людей");
    } catch (e) { setToast("Не вийшло записати: " + e.message); }
    finally { setBusy(false); }
  }

  /* ─── вигляд ─── */
  const card = { background: C.surface, border: "1px solid " + C.line, borderRadius: 4 };
  const btn = (on) => ({ cursor: on ? "pointer" : "default", padding: "8px 14px", borderRadius: 3, border: "1px solid " + (on ? C.line : C.lineSoft), background: C.surface, color: on ? C.ink2 : C.muted });
  const chip = (on) => ({ cursor: "pointer", whiteSpace: "nowrap", borderRadius: 16, padding: "5px 12px", fontSize: 12.5,
    border: "1px solid " + (on ? C.ink : C.line), background: on ? C.ink : C.surface, color: on ? "#fff" : C.ink2 });
  const small = { fontSize: 11.5, color: C.muted };

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <datalist id="pay-people">{rows.map((r) => <option key={r.id} value={r.name} />)}</datalist>

      <section style={{ ...card, padding: "16px 20px" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 21, fontWeight: 600 }}>Відомості ЗП</h2>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 8 }}>
            <button className="ghost" aria-label="Попередній місяць" onClick={() => setPer((p) => { const i = p.y * 12 + p.m - 2; return { ...p, y: Math.floor(i / 12), m: (i % 12) + 1 }; })}>←</button>
            <span className="num" style={{ fontWeight: 600, minWidth: 130, textAlign: "center" }}>{perLabel}</span>
            <button className="ghost" aria-label="Наступний місяць" onClick={() => setPer((p) => { const i = p.y * 12 + p.m; return { ...p, y: Math.floor(i / 12), m: (i % 12) + 1 }; })}>→</button>
          </div>
          <select value={per.half} onChange={(e) => setPer((p) => ({ ...p, half: +e.target.value }))} aria-label="Половина місяця" style={{ width: "auto" }}>
            <option value={1}>перша половина (01–15)</option>
            <option value={2}>друга половина (16–{lastDay(per.y, per.m)})</option>
          </select>
          <button onClick={() => setShowTpl((v) => !v)} style={{ ...btn(true), marginLeft: "auto" }}>Налаштування</button>
          <button onClick={send} disabled={!sheetReady || busy || !statements.length}
            title={sheetReady ? "Записати всі відомості в Google Таблицю — кожна окремою вкладкою" : "Не задано PAY_SHEET_URL у Vercel"}
            style={{ ...btn(sheetReady && !busy), background: sheetReady && !busy ? C.signalSoft : C.surface, color: sheetReady && !busy ? C.signal : C.muted }}>
            {busy ? "Записую…" : "У Google Таблицю"}
          </button>
        </div>
        <p style={{ margin: "10px 0 0", color: C.muted, fontSize: 12.5 }}>
          Теги Штату — за {spanText(staffSpan)}, Гігу — за {spanText(gigSpan)}. Розподіл: «тег як у …» → табель / звіт годин / коригування → фіксований → довідник.
          Юрособа, Штат/Гіг і ІПН задаються тут (або імпортом з таблиці «Теги ЗП»); ПІБ повністю приходить із PeopleForce.
        </p>
        {!sheetReady && (
          <p style={{ margin: "10px 0 0", background: C.warnSoft, borderRadius: 3, padding: "10px 14px", color: C.ink2, fontSize: 12.5 }}>
            Google Таблицю не підключено: встановіть скрипт з <b>apps-script/vidomosti.gs</b> у таблицю відомостей і задайте у Vercel <b>PAY_SHEET_URL</b>, потім Redeploy.
          </p>
        )}
        {sent && (
          <p style={{ margin: "10px 0 0", background: C.signalSoft, borderRadius: 3, padding: "10px 14px", color: C.signal, fontSize: 12.5 }}>
            Записано {sent.tabs} {plural(sent.tabs, "відомість", "відомості", "відомостей")} ({sent.count} людей){sent.noInn ? ", без ІПН: " + sent.noInn : ""}{sent.bad ? ", з проблемами: " + sent.bad : ""}.
            {sent.url && <> <a href={sent.url} target="_blank" rel="noreferrer" style={{ color: C.signal }}>Відкрити таблицю</a></>}
          </p>
        )}
        {showTpl && (
          <div style={{ marginTop: 14, display: "grid", gap: 12, background: "#F4F7FC", border: "1px solid " + C.lineSoft, borderRadius: 3, padding: "14px 16px" }}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <label style={{ fontSize: 12.5 }}>Теги Штату за{" "}
                <select value={staffSpan} onChange={(e) => setPay({ staffSpan: e.target.value })} style={{ width: "auto" }}>
                  <option value="half">половину місяця</option><option value="month">увесь місяць</option>
                </select>
              </label>
              <label style={{ fontSize: 12.5 }}>Теги Гігу за{" "}
                <select value={gigSpan} onChange={(e) => setPay({ gigSpan: e.target.value })} style={{ width: "auto" }}>
                  <option value="month">увесь місяць</option><option value="half">половину місяця</option>
                </select>
              </label>
            </div>
            {[["staff", "Призначення платежу — Штат"], ["gig", "Призначення платежу — Гіг"]].map(([k, l]) => (
              <div key={k}>
                <label style={{ fontSize: 12.5, fontWeight: 600, color: C.ink2 }}>{l}</label>
                <textarea value={tpl[k]} rows={3} style={{ width: "100%", marginTop: 4, fontFamily: "inherit", fontSize: 13 }}
                  onChange={(e) => setPay({ tpl: { ...tpl, [k]: e.target.value } })} />
                <div style={small}>Приклад: {fillTpl(tpl[k], { half: spans[k].half, m: per.m, y: per.y, name: "Прізвище Ім'я", tag: "{prd:cbx-80,cbx_pos-20}" })}</div>
              </div>
            ))}
            <div style={small}>Підстановки: {"{половину}"} (першу/другу половину), {"{місяця}"} (вересня), {"{місяць}"} (вересень), {"{мм}"} (09), {"{рік}"}, {"{ПІБ}"}, {"{тег}"}.
              {" "}<button className="link" onClick={() => setPay({ tpl: DEFAULT_TPL })}>повернути стандартні</button></div>
          </div>
        )}
      </section>

      <section style={{ ...card, padding: "14px 20px" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <button style={chip(view === "all")} onClick={() => setView("all")}>Усі · {rows.length}</button>
          {statements.map((s) => (
            <button key={s.key} style={chip(view === s.key)} onClick={() => setView(s.key)}>
              {s.key} · {s.rows.length}{s.bad ? <span style={{ color: view === s.key ? "#FFD9A8" : C.warn }}> · ⚠ {s.bad}</span> : null}
            </button>
          ))}
          <button style={chip(view === "bad")} onClick={() => setView("bad")}>З проблемами · {badCount}</button>
          <button style={chip(view === "fpv")} onClick={() => setView("fpv")}>FPV · {rows.filter((r) => r.kind === "fpv").length}</button>
          <button style={chip(view === "off")} onClick={() => setView("off")}>Виключені · {rows.filter((r) => r.off).length}</button>
          <input type="text" value={query} onChange={(e) => { setQuery(e.target.value); setShown(80); }} placeholder="Пошук: ім'я або код" aria-label="Пошук у відомостях" style={{ width: 220, marginLeft: "auto" }} />
        </div>
      </section>

      <section style={{ ...card, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 230, position: "sticky", left: 0, background: C.surface }}>ПІБ</th>
                <th style={{ minWidth: 110 }}>Тип</th>
                <th style={{ minWidth: 170 }}>Юрособа</th>
                <th style={{ minWidth: 80 }}>ІПН</th>
                <th style={{ minWidth: 220 }}>Тег</th>
                <th style={{ minWidth: 200 }}>Фікс. розподіл</th>
                <th style={{ minWidth: 170 }}>Тег як у</th>
                <th style={{ minWidth: 70, textAlign: "center" }}>У відомість</th>
              </tr>
            </thead>
            <tbody>
              {visible.slice(0, shown).map((r) => (
                <tr key={r.id} style={r.off ? { opacity: 0.55 } : undefined}>
                  <td style={{ position: "sticky", left: 0, background: C.surface }}>
                    {r.kind === "emp" && openCard
                      ? <button className="link" style={{ color: C.ink, textDecoration: "none", fontWeight: 600, textAlign: "left" }} onClick={() => openCard(r.id)}>{r.name}</button>
                      : <span style={{ fontWeight: 600 }}>{r.name}</span>}
                    <div style={small}>{r.kind === "fpv" ? "FPV" : r.source}{r.notes && r.notes.length ? " · " + r.notes.join("; ") : ""}</div>
                    {!r.off && r.problems.length > 0 && <div style={{ fontSize: 11.5, color: C.warn }}>{r.problems.join(" · ")}</div>}
                  </td>
                  <td style={{ padding: 4 }}>
                    <select value={r.kind === "fpv" ? r.type : (employees.find((e) => e.id === r.id) || {}).payType || ""} aria-label={"Тип, " + r.name}
                      onChange={(e) => edit(r, r.kind === "fpv" ? { type: e.target.value } : { payType: e.target.value })} style={{ padding: "6px 8px" }}>
                      {r.kind !== "fpv" && <option value="">{r.typeAuto ? "з файлу: " + r.typeAuto : "—"}</option>}
                      <option value="Штат">Штат</option><option value="Гіг">Гіг</option>
                    </select>
                  </td>
                  <td style={{ padding: 4 }}>
                    {(() => {
                      const cur = r.kind === "fpv" ? r.legal : (employees.find((e) => e.id === r.id) || {}).payLegal || "";
                      const extra = cur && !legalNames.includes(cur) ? [cur] : [];
                      return (
                        <select value={cur} aria-label={"Юрособа, " + r.name} style={{ padding: "6px 8px", maxWidth: 220 }}
                          onChange={(e) => edit(r, r.kind === "fpv" ? { legal: e.target.value } : { payLegal: e.target.value })}>
                          <option value="">—</option>
                          {legalNames.map((n) => <option key={n} value={n}>{n}</option>)}
                          {extra.map((n) => <option key={"x" + n} value={n}>{n} (немає в довіднику)</option>)}
                        </select>
                      );
                    })()}
                  </td>
                  <td>
                    <button className="link num" style={{ fontSize: 12, color: inn[r.id] ? C.ink2 : C.stop }} onClick={() => askInn(r)}
                      title={inn[r.id] ? "Змінити ІПН" : "Ввести ІПН"}>
                      {inn[r.id] ? (shownInn[r.id] || inn[r.id].m) : "ввести"}
                    </button>
                    {inn[r.id] && <div><button className="link" style={{ fontSize: 11 }} onClick={() => revealInn(r)}>{shownInn[r.id] ? "сховати" : "показати"}</button></div>}
                  </td>
                  <td className="num" style={{ fontSize: 12, wordBreak: "break-all", color: r.tag ? C.ink : C.muted, fontWeight: 600 }}>{r.tag || "—"}</td>
                  <td style={{ padding: 4 }}>
                    <input type="text" defaultValue={r.fixed} key={r.id + "|" + r.fixed} placeholder={r.fileFixed ? "з файлу: " + r.fileFixed : "напр. cbx-80,cbx_pos-20"}
                      aria-label={"Фіксований розподіл, " + r.name} className="num" style={{ fontSize: 12 }} disabled={!canEdit}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && parseFixed(v).bad.length) return setToast("Не розібрав: " + parseFixed(v).bad.join(", ") + ". Формат: cbx-80,cbx_pos-20");
                        edit(r, r.kind === "fpv" ? { fixed: v || "fpv-100" } : { payFixed: v });
                      }} />
                  </td>
                  <td style={{ padding: 4 }}>
                    {r.kind === "emp" ? (
                      <input type="text" list="pay-people" key={r.id + "|" + r.like} defaultValue={r.like ? ((rows.find((x) => x.id === r.like) || {}).name || "") : ""}
                        placeholder="—" aria-label={"Тег як у, " + r.name} disabled={!canEdit}
                        onBlur={(e) => { const id = likeId(e.target.value); if (id === null) return setToast("Не знайшов «" + e.target.value + "» — оберіть зі списку."); setEmp(r.id, { payLike: id }); }} />
                    ) : <span style={small}>—</span>}
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {r.kind === "emp"
                      ? <input type="checkbox" checked={!r.off} disabled={!canEdit} aria-label={"У відомість, " + r.name} style={{ width: "auto" }} onChange={(e) => setEmp(r.id, { payOff: !e.target.checked })} />
                      : <input type="checkbox" checked disabled={!canEdit} aria-label={"У відомість, " + r.name} style={{ width: "auto" }} onChange={() => setF(r.id, { active: false })} title="Зняти — прибрати з активних FPV" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "12px 20px", borderTop: "1px solid " + C.lineSoft, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="num" style={{ color: C.muted, fontSize: 12.5 }}>
            показано {Math.min(shown, visible.length)} з {visible.length} · у відомостях {included.length} · відомостей {statements.length}
          </span>
          {visible.length > shown && <button className="link" onClick={() => setShown((n) => n + 200)}>показати ще</button>}
        </div>
      </section>

      <section style={{ ...card, padding: "16px 20px" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0, fontFamily: SERIF, fontSize: 19, fontWeight: 600 }}>Довідник юросіб</h3>
          <span style={{ color: C.muted, fontSize: 12.5 }}>з цього списку обирається юрособа людини; кожна юрособа — окремі відомості Штат і Гіг</span>
        </div>
        {legalBook.length === 0 ? (
          <p style={{ margin: "12px 0 0", color: C.muted, fontSize: 12.5 }}>Довідник порожній. Додайте юрособи нижче.</p>
        ) : (
          <table style={{ marginTop: 12 }}>
            <thead><tr>
              <th style={{ minWidth: 260 }}>Назва (як у відомостях)</th>
              <th style={{ width: 90, textAlign: "center" }}>Людей</th>
              <th style={{ width: 44 }} />
            </tr></thead>
            <tbody>
              {legalBook.map((x, i) => {
                const used = included.filter((r) => r.legal === x.name).length;
                return (
                  <tr key={x.name + i}>
                    <td style={{ padding: 4 }}>
                      <input type="text" defaultValue={x.name} key={"n" + x.name} disabled={!canEdit} aria-label="Назва юрособи"
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (!v || v === x.name) { e.target.value = x.name; return; }
                          if (legalNames.includes(v)) { setToast("«" + v + "» уже є в довіднику."); e.target.value = x.name; return; }
                          setLegalBook(legalBook.map((y, j) => (j === i ? { ...y, name: v } : y)));
                          // Перейменування переносимо в картки людей і FPV, де юрособу поставили вручну.
                          setEmployees((p) => p.map((e2) => (e2.payLegal === x.name ? { ...e2, payLegal: v, updatedAt: stamp() } : e2)));
                          setFpv((p) => (p || []).map((f) => (f.legal === x.name ? { ...f, legal: v, updatedAt: stamp() } : f)));
                        }} />
                    </td>
                    <td className="num" style={{ textAlign: "center" }}>{used || "—"}</td>
                    <td style={{ textAlign: "center" }}>
                      {canEdit && (
                        <button className="link" aria-label={"Прибрати " + x.name} style={{ color: C.stop }}
                          onClick={() => {
                            if (!window.confirm("Прибрати «" + x.name + "» з довідника?" + (used ? "\n\nЇї зараз мають " + used + " " + plural(used, "людина", "людини", "людей") + " — у них з'явиться позначка «немає в довіднику»." : ""))) return;
                            setLegalBook(legalBook.filter((y, j) => j !== i));
                          }}>×</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {canEdit && (
          <form style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}
            onSubmit={(e) => {
              e.preventDefault();
              const v = e.target.elements.newLegal.value.trim();
              if (!v) return;
              if (legalNames.some((n) => low(n) === low(v))) return setToast("«" + v + "» уже є в довіднику.");
              setLegalBook([...legalBook, { name: v }]);
              e.target.reset();
            }}>
            <input name="newLegal" type="text" placeholder="ТОВ «…» або ФОП …" aria-label="Нова юрособа" style={{ width: 320 }} />
            <button type="submit" style={btn(true)}>Додати</button>
          </form>
        )}
      </section>

      <section style={{ ...card, padding: "16px 20px" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0, fontFamily: SERIF, fontSize: 19, fontWeight: 600 }}>Довідник FPV</h3>
          <span style={{ color: C.muted, fontSize: 12.5 }}>окремі люди поза PeopleForce; у відомості йдуть разом з усіма, розподіл за замовчуванням fpv-100</span>
          {canEdit && <button onClick={() => fileRef.current && fileRef.current.click()} style={{ ...btn(true), marginLeft: "auto" }}>Імпорт з таблиці «Теги ЗП»</button>}
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} aria-label="Файл з аркушем «Співробітники»"
            onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) readFile(f); e.target.value = ""; }} />
        </div>
        {imp && (
          <div style={{ marginTop: 14, background: "#F4F7FC", border: "1px solid " + C.lineSoft, borderRadius: 3, padding: "14px 16px", fontSize: 13 }}>
            <p style={{ margin: 0, fontWeight: 600 }}>«{imp.file}», аркуш «{imp.sheet}»</p>
            <p style={{ margin: "6px 0 0" }}>FPV (розподіл лише fpv): <b>{imp.fp.length}</b> — нових {imp.fp.filter((x) => !x.old).length}, оновиться {imp.fp.filter((x) => x.old).length}. ІПН зберігаються окремо — бачать лише адміністратор і бухгалтер.</p>
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <input type="checkbox" checked={imp.withEmp} style={{ width: "auto" }} onChange={(e) => setImp((x) => ({ ...x, withEmp: e.target.checked }))} />
              Співробітникам, яких знайдено в довіднику ({imp.emp.length}), записати фіксований розподіл (якщо немає табеля) і Штат/Гіг з файлу
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
              <input type="checkbox" checked={imp.withInn} style={{ width: "auto" }} onChange={(e) => setImp((x) => ({ ...x, withInn: e.target.checked }))} />
              і їхні ІПН з файлу
            </label>
            {imp.lost.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: "pointer", color: C.warn }}>Не знайдено в довіднику: {imp.lost.length} — їх пропустимо</summary>
                <p style={{ margin: "6px 0 0", color: C.muted }}>{imp.lost.map((x) => x.name).join(", ")}</p>
              </details>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button className="ghost" onClick={applyImport} style={{ ...btn(true), background: C.signalSoft, color: C.signal }}>Імпортувати</button>
              <button className="ghost" onClick={() => setImp(null)}>Скасувати</button>
            </div>
          </div>
        )}
        {canEdit && <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <input type="text" value={newFpv} onChange={(e) => setNewFpv(e.target.value)} placeholder="Прізвище Ім'я По батькові" aria-label="Нова людина FPV"
            onKeyDown={(e) => { if (e.key === "Enter") addFpv(); }} style={{ width: 320 }} />
          <button onClick={addFpv} style={btn(true)}>Додати</button>
        </div>}
        {(fpv || []).filter((f) => f.active === false).length > 0 && (
          <details style={{ marginTop: 10, fontSize: 12.5 }}>
            <summary style={{ cursor: "pointer", color: C.muted }}>Неактивні FPV: {(fpv || []).filter((f) => f.active === false).length}</summary>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {(fpv || []).filter((f) => f.active === false).map((f) => (
                <li key={f.id}>{f.name}{canEdit && <> · <button className="link" onClick={() => setF(f.id, { active: true })}>повернути</button></>}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}
