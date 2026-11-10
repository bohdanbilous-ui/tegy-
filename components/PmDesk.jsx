"use client";
/* Робоче місце PM. Дані приходять з /api/pm — лише проєкти, де ім'я людини стоїть
   у полі «PM, який погоджує». Тут PM:
     • погоджує або заперечує переведення, що стосуються його проєктів;
     • бачить людей своїх проєктів;
     • вносить факт по тимчасових і часткових переведеннях, які приймає його проєкт:
       скільки годин людина відпрацювала за завершену половину місяця (або «як заплановано»);
     • підтверджує факт по своїх людях, яких приймають інші проєкти (лише підтверджені години впливають на теги);
     • подає заявку на переведення.
   На проєкті може бути кілька PM: будь-хто з них діє від імені проєкту. */
import React, { useState, useEffect, useMemo } from "react";
import { normHours, lendersOf } from "../lib/loans";
import { pmText } from "../lib/pms";
import Info from "./Info";

const C = {
  paper: "#F5F7FB", surface: "#FFFFFF", ink: "#0F172A", ink2: "#334155",
  muted: "#64748B", line: "#DDE3EC", lineSoft: "#EEF2F6",
  signal: "#2563EB", signalSoft: "#EFF6FF", plan: "#4F46E5", planSoft: "#EEF2FF",
  warn: "#B45309", warnSoft: "#FFF7ED", stop: "#B91C1C", stopSoft: "#FEF2F2",
};
const SANS = '"Inter",ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const pad = (n) => String(n).padStart(2, "0");
const fmt = (s) => (s ? s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4) : "—");
const fmtDT = (s) => { const d = new Date(s); return isNaN(d) ? "—" : pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const lastDay = (y, m) => new Date(y, m, 0).getDate();
const keyOf = (p) => p.y + "-" + pad(p.m) + "-H" + p.half;
const perOf = (k) => ({ y: +k.slice(0, 4), m: +k.slice(5, 7), half: k.endsWith("H1") ? 1 : 2 });
const perOfDate = (d) => ({ y: +d.slice(0, 4), m: +d.slice(5, 7), half: +d.slice(8, 10) <= 15 ? 1 : 2 });
const perLabel = (k) => { const p = perOf(k); return MONTHS[p.m - 1] + " " + p.y + ", " + (p.half === 1 ? "01–15" : "16–" + lastDay(p.y, p.m)); };
const shift = (k, n) => {
  const p = perOf(k);
  let idx = p.y * 24 + (p.m - 1) * 2 + (p.half - 1) + n;
  const y = Math.floor(idx / 24); idx -= y * 24;
  return keyOf({ y, m: Math.floor(idx / 2) + 1, half: (idx % 2) + 1 });
};
const addDaysISO = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
// Факт за половину місяця потрібен не пізніше ніж через 3 дні після її кінця: далі за ним іде відомість ЗП.
const FACT_GRACE_DAYS = 3;
const periodEnd = (k) => { const p = perOf(k); return p.y + "-" + pad(p.m) + "-" + pad(p.half === 1 ? 15 : lastDay(p.y, p.m)); };
const dueOf = (k) => addDaysISO(periodEnd(k), FACT_GRACE_DAYS);
const allocText = (a) => (!a || !a.length ? "—" : a.map((x) => (x.percent === 100 ? x.project : x.project + " " + Number(Number(x.percent).toFixed(2)) + "%")).join(" + "));
const plural = (n, a, b, c) => { const m = n % 100; if (m > 10 && m < 20) return c; const k = n % 10; return k === 1 ? a : k > 1 && k < 5 ? b : c; };

const LOAN = { pending: ["чекає на підтвердження", C.warn, C.warnSoft], confirmed: ["підтверджено", C.signal, C.signalSoft], rejected: ["відхилено", C.stop, C.stopSoft] };
const APPR = { pending: ["чекає", C.warn, C.warnSoft], approved: ["погоджено", C.signal, C.signalSoft], rejected: ["заперечення", C.stop, C.stopSoft] };
const REQ = { new: ["на розгляді", C.warn, C.warnSoft], done: ["виконано", C.signal, C.signalSoft], rejected: ["відхилено", C.stop, C.stopSoft] };
const Pill = ({ v }) => <span style={{ background: v[2], color: v[1], borderRadius: 999, padding: "2px 9px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{v[0]}</span>;

async function call(token, method, body) {
  const res = await fetch("/api/pm", {
    method, cache: "no-store",
    headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || "HTTP " + res.status); e.status = res.status; throw e; }
  return data;
}

export default function PmDesk({ user, token, onSignOut, onApiError }) {
  const [data, setData] = useState(null);
  const TAB_KEYS = ["request", "home", "approve", "people", "loans", "confirm", "history"];
  const [tab, setTabState] = useState("request");
  // Розділ у адресі (#approve): оновлення сторінки й «назад» не кидають на головну.
  useEffect(() => {
    const fromHash = () => { const h = String(window.location.hash || "").replace("#", ""); if (TAB_KEYS.includes(h)) setTabState(h); };
    fromHash(); window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  const setTab = (k) => { setTabState(k); try { window.history.replaceState(null, "", "#" + k); } catch {} if (typeof window !== "undefined") window.scrollTo({ top: 0 }); };
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState({});
  const [q, setQ] = useState("");

  async function load() {
    try { setData(await call(token, "GET")); }
    catch (e) { if (e.status === 401) onApiError && onApiError(e); else setToast(e.message); }
  }
  useEffect(() => { load(); const id = setInterval(() => { if (!document.hidden) load(); }, 60000); return () => clearInterval(id); }, [token]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 5000); return () => clearTimeout(id); }, [toast]);

  async function act(body, okText) {
    setBusy(true);
    try { setData(await call(token, "POST", body)); if (okText) setToast(okText); return true; }
    catch (e) { if (e.status === 401) onApiError && onApiError(e); else setToast(e.message); return false; }
    finally { setBusy(false); }
  }

  // Масове погодження: по одному запиту на рішення, поспіль; помилки не зупиняють решту (крім виходу з сесії).
  async function runBulk(reqs, doneText) {
    if (!reqs.length) return;
    setBusy(true);
    let ok = 0, last = null, firstErr = "";
    try {
      for (const body of reqs) {
        try { last = await call(token, "POST", body); ok++; }
        catch (e) { if (e.status === 401) { onApiError && onApiError(e); return; } if (!firstErr) firstErr = e.message; }
      }
      if (last) setData(last); else await load();
      setToast(doneText + ": " + ok + " з " + reqs.length + (firstErr ? ". Не вдалося: " + firstErr : ""));
    } finally { setBusy(false); }
  }

  const mine = useMemo(() => new Set((data && data.myProjects) || []), [data]);
  const isAdmin = data && data.me.role === "admin";
  const pendingApprovals = data ? data.approvals.filter((t) => t.approvals.some((a) => mine.has(a.project) && a.status === "pending")) : [];
  const incomingPending = data ? (data.incoming || []).filter((r) => r.status === "new" && (r.approvals || []).some((a) => a.role === "give" && mine.has(a.project) && a.status === "pending")) : [];
  const meName = data ? String(data.me.name || "").trim().toLowerCase() : "";
  // Те, що я можу підтвердити: PM проєкту, звідки людина; власні записи — ні (їх підтверджує колега або адміністратор).
  const toConfirm = data ? data.loans.filter((l) => l.status === "pending" && !l.stale
    && (isAdmin || (lendersOf(l).some((p) => mine.has(p)) && String(l.createdBy || "").trim().toLowerCase() !== meName))) : [];

  const approveReqs = pendingApprovals.flatMap((t) => t.approvals.filter((a) => mine.has(a.project) && a.status === "pending")
    .map((a) => ({ action: "decide", transferId: t.id, project: a.project, ok: true, comment: "" })));
  const incomingReqs = incomingPending.flatMap((x) => (x.approvals || []).filter((a) => a.role === "give" && mine.has(a.project) && a.status === "pending")
    .map((a) => ({ action: "req-decide", requestId: x.id, project: a.project, ok: true, comment: "" })));
  const bulk = (reqs, what, doneText) => {
    if (!reqs.length) return;
    if (!window.confirm(what + ": " + reqs.length + ". Підтвердити все одразу? Заперечити можна лише окремо, з коментарем.")) return;
    runBulk(reqs, doneText);
  };

  const card = { background: C.surface, border: "1px solid " + C.line, borderRadius: 10, boxShadow: "0 1px 2px rgba(15,23,42,.04)" };
  const addBtn = { cursor: "pointer", background: C.signal, color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontWeight: 600, whiteSpace: "nowrap" };
  const label = { fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 6, display: "block" };
  const css = `
    .pm *, .pm *::before, .pm *::after { box-sizing: border-box; }
    .pm button, .pm input, .pm select, .pm textarea { font: inherit; color: inherit; }
    .pm input[type=text], .pm input[type=number], .pm input[type=date], .pm select, .pm textarea { border: 1px solid ${C.line}; border-radius: 8px; padding: 7px 9px; background: #fff; min-height: 36px; }
    .pm :focus-visible { outline: 2px solid ${C.signal}; outline-offset: 2px; border-radius: 6px; }
    .pm table { border-collapse: separate; border-spacing: 0; width: 100%; }
    .pm th, .pm td { text-align: left; padding: 8px 12px; vertical-align: top; }
    .pm th { font-size: 11.5px; font-weight: 600; color: ${C.muted}; text-transform: uppercase; letter-spacing: .04em; background: #F8FAFC; border-bottom: 1px solid ${C.line}; }
    .pm td { border-bottom: 1px solid ${C.lineSoft}; font-size: 13.5px; }
    .pm .num { font-variant-numeric: tabular-nums; }
    .pm .ghost { cursor: pointer; background: ${C.surface}; border: 1px solid ${C.line}; border-radius: 8px; padding: 8px 13px; color: ${C.ink2}; font-weight: 500; }
    .pm .ghost:hover { border-color: #CBD5E1; background: #F8FAFC; color: ${C.ink}; }
    .pm .link { cursor: pointer; background: none; border: none; padding: 0; color: ${C.signal}; font-weight: 500; }
    .pm .link:hover { text-decoration: underline; }
    .pm .bar { background: #0B1733; color: #C7D2E4; }
    .pm .logo { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; font-weight: 700; color: #fff; background: linear-gradient(135deg, #3B82F6, #1D4ED8); }
    .pm .navwrap { position: sticky; top: 0; z-index: 20; }
    .pm .tabs { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
    .pm .tabs::-webkit-scrollbar { display: none; }
    .pm .tab { cursor: pointer; border: none; background: transparent; padding: 8px 12px; border-radius: 8px; color: ${C.ink2}; white-space: nowrap; flex: 0 0 auto; }
    .pm .tab:hover:not(.on) { background: #F1F5F9; }
    .pm .qrow { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 12px; border: 1px solid ${C.line}; border-radius: 8px; }
    .pm .tab.on { background: ${C.ink}; color: #fff; font-weight: 600; }
    .pm .badge { background: ${C.warn}; color: #fff; border-radius: 999px; padding: 0 7px; font-size: 11.5px; margin-left: 6px; }
    .pm .scroll { overflow-x: auto; }
    @media (max-width: 640px) { .pm main { padding: 16px !important; } .pm th, .pm td { padding: 8px 10px; } }
  `;

  const todoTotal = pendingApprovals.length + incomingPending.length + (data ? data.todo.length : 0) + toConfirm.length;
  const TABS = [
    ["request", "Нова заявка", 0],
    ["home", "Що зробити", todoTotal],
    ["approve", "Погодження", pendingApprovals.length + incomingPending.length],
    ["people", "Люди", 0],
    ["loans", "Внести факт", data ? data.todo.length : 0],
    ["confirm", "Години колег", toConfirm.length],
    ["history", "Історія рішень", 0],
  ];

  return (
    <div className="pm" style={{ background: C.paper, minHeight: "100vh", fontFamily: SANS, color: C.ink, fontSize: 14 }}>
      <style>{css}</style>
      <header className="bar">
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "14px 24px", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <span className="logo" aria-hidden="true">A</span>
          <div>
            <div style={{ color: "#fff", fontWeight: 700, fontSize: 16 }}>Allocate <span style={{ color: "#8A9BB8", fontWeight: 500 }}>· PM</span></div>
            <div style={{ fontSize: 12, color: "#8A9BB8" }}>{data && data.myProjects.length ? data.myProjects.join(", ") : "проєкти, де ви PM"}</div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 14, alignItems: "center", fontSize: 13 }}>
            <span style={{ color: "#fff", fontWeight: 600 }}>{user.name}</span>
            <button className="link" style={{ color: "#AEBBD3" }} onClick={onSignOut}>вийти</button>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: 18, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
        {!data && <section style={{ ...card, padding: 30, color: C.muted }}>Завантажуємо…</section>}

        {data && !data.myProjects.length && !isAdmin && (
          <section style={{ ...card, padding: 24 }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>За вами поки не закріплено жодного проєкту</h2>
            <p style={{ color: C.ink2, marginBottom: 0 }}>
              Попросіть адміністратора вписати «{user.name}» у поле «PM, який погоджує» потрібного проєкту (Довідник → Проєкти; якщо PM кілька — імена через «;»). Ім'я має збігатися буква в букву.
              Поки що ви можете подати заявку на переведення.
            </p>
          </section>
        )}

        {data && (
          <section className="navwrap" style={{ ...card, padding: 4 }}>
            <nav className="tabs" aria-label="Розділи">
              {TABS.map(([k, l, n]) => (
                <button key={k} className={"tab" + (tab === k ? " on" : "")} aria-current={tab === k} onClick={() => setTab(k)}>
                  {l}{n ? <span className="badge">{n}</span> : null}
                </button>
              ))}
            </nav>
          </section>
        )}

        {data && tab === "home" && (
          <Home data={data} card={card} go={setTab} isAdmin={isAdmin} busy={busy} act={act}
            overdue={{ facts: data.todo.filter((x) => dueOf(x.periodKey) < data.today).length, approve: pendingApprovals.filter((t) => t.effectiveDate < data.today).length }}
            counts={{ approve: pendingApprovals.length, incoming: incomingPending.length, facts: data.todo.length, confirm: toConfirm.length }}
            quick={pendingApprovals.slice(0, 5)} mine={mine}
            onApproveOne={(t) => runBulk(t.approvals.filter((a) => mine.has(a.project) && a.status === "pending")
              .map((a) => ({ action: "decide", transferId: t.id, project: a.project, ok: true, comment: "" })), "Погоджено")} />
        )}
        {data && tab === "approve" && <Approvals data={data} mine={mine} notes={notes} setNotes={setNotes} busy={busy} act={act} card={card}
          onApproveAll={() => bulk(approveReqs, "Погодити переведень", "Погоджено")} onApproveAllReq={() => bulk(incomingReqs, "Погодити запитів на ваших людей", "Погоджено")}
          nApprove={approveReqs.length} nReq={incomingReqs.length} />}
        {data && tab === "people" && <People data={data} mine={mine} q={q} setQ={setQ} card={card} />}
        {data && tab === "loans" && <Facts data={data} mine={mine} isAdmin={isAdmin} busy={busy} act={act} card={card} />}
        {data && tab === "history" && <History data={data} card={card} />}
        {data && tab === "confirm" && <Confirm data={data} mine={mine} isAdmin={isAdmin} list={toConfirm} notes={notes} setNotes={setNotes} busy={busy} act={act} card={card} />}
        {data && tab === "request" && <Request data={data} busy={busy} act={act} card={card} addBtn={addBtn} label={label} />}
      </main>

      {toast && (
        <div role="status" style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 24, background: C.ink, color: "#fff", padding: "12px 18px", borderRadius: 8, boxShadow: "0 8px 24px rgba(20,30,56,.24)", maxWidth: "90vw", zIndex: 30 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

/* ── заступник: на час відсутності колега погоджує й вносить факт від імені моїх проєктів ── */
function Deputy({ data, busy, act }) {
  const mineDep = data.deputy.mine;
  const [who, setWho] = useState("");
  const [from, setFrom] = useState(data.today);
  const [to, setTo] = useState(addDaysISO(data.today, 7));
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {mineDep ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13.5 }}>
          <span>Ваш заступник: <b>{mineDep.deputy}</b>, {fmt(mineDep.from)} — {fmt(mineDep.to)}</span>
          <button className="ghost" disabled={busy} onClick={() => act({ action: "deputy-clear" }, "Заступника знято")}>Зняти</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ fontSize: 12.5, color: C.muted }}>Заступник
            <select value={who} onChange={(e) => setWho(e.target.value)} style={{ display: "block", minWidth: 200 }} aria-label="Заступник">
              <option value="">— оберіть PM —</option>
              {data.deputy.candidates.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12.5, color: C.muted }}>З <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ display: "block" }} /></label>
          <label style={{ fontSize: 12.5, color: C.muted }}>До <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ display: "block" }} /></label>
          <button className="ghost" disabled={busy || !who} onClick={() => act({ action: "deputy-set", deputy: who, from, to }, "Заступника призначено")}>Призначити</button>
        </div>
      )}
      <div style={{ fontSize: 12.5, color: C.muted }}>Поки заступництво діє, колега бачить ваші завдання, погоджує й вносить години від імені ваших проєктів. Кожна дія підписана його іменем.</div>
    </div>
  );
}

/* ── головна: що робити зараз ── */
function Home({ data, card, go, counts, overdue, isAdmin, busy, act, quick, mine, onApproveOne }) {
  const items = [
    ["approve", counts.approve, "Переведення чекають на ваше погодження", "Погоджуєте вже доконане переведення: ваша людина йде або приходить до проєкту.", overdue.approve ? overdue.approve + " уже діють" : ""],
    ["approve", counts.incoming, "Запити на людей з ваших проєктів", "Інший PM просить вашу людину. Ваше слово бачить адміністратор.", ""],
    ["loans", counts.facts, "Внести факт по годинах", "Людина тимчасово або частково працює у вашому проєкті: впишіть, скільки годин вона відпрацювала.", overdue.facts ? overdue.facts + " прострочено" : ""],
    ["confirm", counts.confirm, "Підтвердити години колег", "Колега вніс години вашої людини в його проєкті. Підтвердження впливає на теги.", ""],
  ];
  const open = items.filter((x) => x[1] > 0);
  const soon = (data.upcoming || []).slice(0, 4);
  return (
    <>
    {data.deputy.covering.length > 0 && (
      <section style={{ ...card, padding: "12px 20px", background: C.planSoft, borderColor: "#C7D2FE" }}>
        Ви заступаєте {data.deputy.covering.map((d) => d.pm + " до " + fmt(d.to)).join("; ")}: їхні проєкти додані до ваших.
      </section>
    )}
    <section style={{ ...card, padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{open.length ? "Що потрібно зробити" : "Усе зроблено ✓"}</h2>
        <span style={{ color: C.muted, fontSize: 13 }}>{data.myProjects.length ? "Ваші проєкти: " + data.myProjects.join(", ") : isAdmin ? "Режим адміністратора" : ""}</span>
      </div>
      {open.length === 0 && <p style={{ margin: 0, color: C.muted }}>Зараз від вас нічого не потрібно. Нові завдання зʼявляться тут і прийдуть у Slack.</p>}
      <div style={{ display: "grid", gap: 10 }}>
        {open.map(([tab, n, title, hint, late], i) => (
          <button key={i} onClick={() => go(tab)} style={{ cursor: "pointer", textAlign: "left", display: "flex", gap: 14, alignItems: "center", background: late ? C.stopSoft : C.warnSoft, border: "1px solid " + (late ? "#FECACA" : "#FED7AA"), borderRadius: 10, padding: "10px 14px" }}>
            <span className="num" style={{ fontSize: 22, fontWeight: 700, color: late ? C.stop : C.warn, minWidth: 36 }}>{n}</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontWeight: 600 }}>{title}{late && <span style={{ color: C.stop, fontWeight: 600, fontSize: 12.5 }}> · {late}</span>}</span>
              <span style={{ display: "block", color: C.ink2, fontSize: 12.5, marginTop: 2 }}>{hint}</span>
            </span>
            <span style={{ color: late ? C.stop : C.warn, fontWeight: 600 }}>Відкрити →</span>
          </button>
        ))}
      </div>
      {quick.length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 12.5, color: C.muted, fontWeight: 600 }}>Погодити одразу</div>
          {quick.map((t) => (
            <div key={t.id} className="qrow">
              <b>{t.employeeName}</b>
              <span style={{ color: C.ink2, fontSize: 13 }}>{allocText(t.from)} → {allocText(t.to)} · з {fmt(t.effectiveDate)}{t.effectiveDate < data.today ? " (вже діє)" : ""}</span>
              <button className="ghost" disabled={busy} style={{ marginLeft: "auto" }} onClick={() => onApproveOne(t)}>Погодити</button>
              <button className="link" onClick={() => go("approve")}>Деталі</button>
            </div>
          ))}
          {counts.approve > quick.length && <button className="link" style={{ justifySelf: "start" }} onClick={() => go("approve")}>Ще {counts.approve - quick.length} у розділі «Погодження»</button>}
        </div>
      )}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <button className="link" onClick={() => go("people")}>Люди ваших проєктів</button>
        <button className="link" onClick={() => go("request")}>Подати заявку на переведення</button>
        <button className="link" onClick={() => go("history")}>Історія рішень</button>
      </div>
      <Info>
        PM — людина, вписана в поле «PM, який погоджує» проєкту. Ви: 1) погоджуєте переведення людей ваших проєктів; 2) вносите години по тимчасових і часткових переведеннях,
        які приймає ваш проєкт; 3) підтверджуєте години колег по ваших людях; 4) подаєте заявку, якщо вам потрібна людина з іншого проєкту.
        Переведення діє з дати незалежно від погодження — ви підтверджуєте вже доконане. Години підтверджуються лише по одному запису; «Погодити всі» є тільки для переведень і запитів у розділі «Погодження».
        Факт за половину місяця треба внести до {FACT_GRACE_DAYS}-го дня після її завершення, бо за ним іде відомість ЗП.
      </Info>
    </section>
    {soon.length > 0 && (
      <section style={{ ...card, padding: "14px 20px", display: "grid", gap: 6 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Найближчі зміни на ваших проєктах</h3>
          <button className="link" style={{ marginLeft: "auto" }} onClick={() => go("people")}>усі</button>
        </div>
        {soon.map((u, i) => <UpcomingLine key={i} u={u} today={data.today} />)}
      </section>
    )}
    <section style={{ ...card, padding: "14px 20px" }}>
      <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Заступник на час відсутності</h3>
      <Deputy data={data} busy={busy} act={act} />
    </section>
    </>
  );
}

const UPC = { join: ["приходить", C.signal], leave: ["іде", C.stop], back: ["повертається", C.signal], end: ["тимчасово закінчується, йде", C.warn] };
function UpcomingLine({ u, today }) {
  const [t, color] = UPC[u.kind];
  const d = daysBetween(today, u.date);
  return (
    <div style={{ display: "flex", gap: 10, fontSize: 13.5, flexWrap: "wrap" }}>
      <span className="num" style={{ color: C.muted, minWidth: 92 }}>{fmt(u.date)}{d >= 0 ? " · " + (d === 0 ? "сьогодні" : "через " + d + " дн.") : ""}</span>
      <b>{u.employeeName}</b>
      <span style={{ color }}>{t}</span>
      <span>{u.project} {Number(u.percent.toFixed(2))}%{u.temporary && u.kind === "join" && u.returnDate ? " до " + fmt(u.returnDate) : ""}</span>
    </div>
  );
}

/* ── погодження ── */
function Approvals({ data, mine, notes, setNotes, busy, act, card, onApproveAll, onApproveAllReq, nApprove, nReq }) {
  const [onlyPending, setOnlyPending] = useState(true);
  const list = data.approvals.filter((t) => !onlyPending || t.approvals.some((a) => mine.has(a.project) && a.status === "pending"));
  return (
    <>
    <Incoming data={data} mine={mine} notes={notes} setNotes={setNotes} busy={busy} act={act} card={card} onApproveAll={onApproveAllReq} n={nReq} />
    <section style={{ ...card, padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Переведення ваших проєктів</h2>
        {nApprove > 0 && <button className="ghost" disabled={busy} onClick={onApproveAll} style={{ marginLeft: "auto" }}>Погодити всі · {nApprove}</button>}
        <label style={{ fontSize: 13, color: C.ink2, marginLeft: nApprove > 0 ? 0 : "auto" }}>
          <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} /> лише ті, що чекають на вас
        </label>
      </div>
      <Info style={{ margin: 0 }}>
        Переведення діє з дати незалежно від погодження — ви підтверджуєте вже доконане. {data.approvalMode === "both"
          ? "Погоджують обидві сторони: і той, хто віддає, і той, хто приймає."
          : "Обов'язкове слово того, хто віддає людину; той, хто приймає, бачить запис до відома."}
      </Info>
      {!list.length && <p style={{ margin: 0, color: C.muted }}>{onlyPending ? "Нічого не чекає на ваше рішення." : "Переведень за останні місяці немає."}</p>}
      {list.map((t) => (
        <div key={t.id} style={{ border: "1px solid " + C.line, borderRadius: 10, padding: 14, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            <b>{t.employeeName}</b>
            <span style={{ color: C.muted, fontSize: 12.5 }}>з {fmt(t.effectiveDate)}{t.temporary ? " тимчасово до " + fmt(t.returnDate) : ""} · провів(ла) {t.partner || "—"}</span>
          </div>
          <div style={{ fontSize: 13.5 }}>{allocText(t.from)} → <b>{allocText(t.to)}</b></div>
          {(t.reason || t.note) && <div style={{ fontSize: 12.5, color: C.ink2 }}>{[t.reason, t.note].filter(Boolean).join(" · ")}</div>}
          {t.approvals.filter((a) => mine.has(a.project)).map((a) => {
            const key = t.id + ":" + a.project;
            return (
              <div key={a.project} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "#F8FAFC", borderRadius: 8, padding: "8px 10px" }}>
                <span style={{ fontSize: 13 }}><b>{a.project}</b> {a.role === "give" ? "віддає" : "приймає"} {Number(a.delta.toFixed(2))}%</span>
                <Pill v={APPR[a.status] || APPR.pending} />
                {a.status !== "pending" && <span style={{ fontSize: 12, color: C.muted }}>{a.by}{a.comment ? " · «" + a.comment + "»" : ""}</span>}
                {a.status === "pending" && (
                  <>
                    <input type="text" placeholder="коментар (для заперечення — обов'язково)" value={notes[key] || ""} onChange={(e) => setNotes((n) => ({ ...n, [key]: e.target.value }))} style={{ flex: "1 1 220px" }} />
                    <button className="ghost" disabled={busy} onClick={() => act({ action: "decide", transferId: t.id, project: a.project, ok: true, comment: notes[key] || "" }, "Погоджено")}>Погодити</button>
                    <button className="ghost" disabled={busy} style={{ color: C.stop }} onClick={() => act({ action: "decide", transferId: t.id, project: a.project, ok: false, comment: notes[key] || "" }, "Заперечення надіслано")}>Заперечити</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </section>
    </>
  );
}

/* ── запити на людей з моїх проєктів (заявки інших PM) ── */
function Incoming({ data, mine, notes, setNotes, busy, act, card, onApproveAll, n }) {
  const list = data.incoming || [];
  if (!list.length) return null;
  return (
    <section style={{ ...card, padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Запити на людей з ваших проєктів</h2>
        {n > 0 && <button className="ghost" disabled={busy} onClick={onApproveAll} style={{ marginLeft: "auto" }}>Погодити всі · {n}</button>}
        <Info style={{ flexBasis: "100%", margin: "0" }}>Інший PM просить людину з вашого проєкту. Ваше слово — до адміністратора: він побачить рішення й створить переведення.</Info>
      </div>
      {list.map((r) => (
        <div key={r.id} style={{ border: "1px solid " + C.line, borderRadius: 10, padding: 14, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            <b>{r.employee}</b>
            <span style={{ color: C.muted, fontSize: 12.5 }}>з {fmt(r.effectiveDate)}{r.temporary ? " тимчасово до " + fmt(r.returnDate) : ""} · просить {r.requester || "—"}</span>
            {r.status !== "new" && <Pill v={REQ[r.status] || REQ.new} />}
          </div>
          <div style={{ fontSize: 13.5 }}>{allocText(r.from)} → <b>{allocText(r.alloc)}</b></div>
          {(r.reason || r.note) && <div style={{ fontSize: 12.5, color: C.ink2 }}>{[r.reason, r.note].filter(Boolean).join(" · ")}</div>}
          {(r.approvals || []).filter((a) => a.role === "give" && mine.has(a.project)).map((a) => {
            const key = r.id + ":" + a.project;
            return (
              <div key={a.project} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "#F8FAFC", borderRadius: 8, padding: "8px 10px" }}>
                <span style={{ fontSize: 13 }}><b>{a.project}</b> віддає {Number(Number(a.delta).toFixed(2))}%</span>
                <Pill v={APPR[a.status] || APPR.pending} />
                {a.status !== "pending" && <span style={{ fontSize: 12, color: C.muted }}>{a.by}{a.comment ? " · «" + a.comment + "»" : ""}</span>}
                {r.status === "new" && (
                  <>
                    {a.status === "pending" && <input type="text" placeholder="коментар (для заперечення — обов'язково)" value={notes[key] || ""} onChange={(e) => setNotes((n) => ({ ...n, [key]: e.target.value }))} style={{ flex: "1 1 220px" }} />}
                    {a.status !== "approved" && <button className="ghost" disabled={busy} onClick={() => act({ action: "req-decide", requestId: r.id, project: a.project, ok: true, comment: notes[key] || "" }, "Погоджено")}>Погодити</button>}
                    {a.status !== "rejected" && <button className="ghost" disabled={busy} style={{ color: C.stop }} onClick={() => act({ action: "req-decide", requestId: r.id, project: a.project, ok: false, comment: notes[key] || "" }, "Заперечення надіслано")}>Заперечити</button>}
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}

/* ── люди проєктів ── */
function People({ data, mine, q, setQ, card }) {
  const on = new Set(data.onMine);
  const ql = q.trim().toLowerCase();
  const all = data.people.filter((p) => on.has(p.id));
  const rows = all.filter((p) => !ql || (p.name + " " + p.position).toLowerCase().includes(ql));
  const stat = {};
  [...mine].forEach((pr) => { stat[pr] = { fte: 0, n: 0 }; });
  all.forEach((p) => p.alloc.forEach((r) => { if (mine.has(r.project)) { stat[r.project].fte += r.percent / 100; stat[r.project].n++; } }));
  const sum = (p) => p.alloc.reduce((s2, x) => s2 + x.percent, 0);
  const partial = all.filter((p) => sum(p) < 99.9 || sum(p) > 100.1);
  const nextOf = (id) => (data.upcoming || []).find((u) => u.employeeId === id);
  return (
    <>
      <section style={{ ...card, padding: "16px 20px", display: "grid", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Ваші проєкти</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 10 }}>
          {Object.entries(stat).map(([pr, v]) => {
            const ch = (data.upcoming || []).filter((u) => u.project === pr);
            return (
              <div key={pr} style={{ border: "1px solid " + C.line, borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ fontWeight: 600 }}>{pr}</div>
                <div className="num" style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>{Number(v.fte.toFixed(2))} <span style={{ fontSize: 12, fontWeight: 500, color: C.muted }}>ставки</span></div>
                <div style={{ fontSize: 12.5, color: C.muted }}>{v.n} {plural(v.n, "людина", "людини", "людей")}{ch.length ? " · змін найближчим часом: " + ch.length : ""}</div>
              </div>
            );
          })}
        </div>
        {partial.length > 0 && (
          <div style={{ background: C.warnSoft, borderRadius: 8, padding: "8px 12px", fontSize: 12.5, color: C.warn }}>
            Розподіл не дорівнює 100%: {partial.slice(0, 6).map((p) => p.name + " (" + Number(sum(p).toFixed(1)) + "%)").join(", ")}{partial.length > 6 ? " та ще " + (partial.length - 6) : ""}.
            Повідомте адміністратору, щоб людина не лишилася без тегу.
          </div>
        )}
      </section>
      {(data.upcoming || []).length > 0 && (
        <section style={{ ...card, padding: "16px 20px", display: "grid", gap: 6 }}>
          <h2 style={{ margin: "0 0 4px", fontSize: 17 }}>Найближчі 45 днів</h2>
          {data.upcoming.map((u, i) => <UpcomingLine key={i} u={u} today={data.today} />)}
        </section>
      )}
      <section style={{ ...card, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid " + C.lineSoft }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>Люди сьогодні</h2>
          <input type="text" placeholder="пошук" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: "auto", width: 220 }} />
        </div>
        <div className="scroll">
          <table>
            <thead><tr><th>Людина</th><th>Посада</th><th>Розподіл</th><th>Далі</th></tr></thead>
            <tbody>
              {rows.map((p) => {
                const n = nextOf(p.id);
                return (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td style={{ color: C.ink2 }}>{p.position || "—"}</td>
                    <td>{p.alloc.map((r, i) => <span key={r.project} style={{ fontWeight: mine.has(r.project) ? 600 : 400, color: mine.has(r.project) ? C.ink : C.muted }}>{i ? " + " : ""}{r.project} {Number(r.percent.toFixed(2))}%</span>)}</td>
                    <td style={{ fontSize: 12.5, color: n ? UPC[n.kind][1] : C.muted }}>{n ? fmt(n.date) + " · " + UPC[n.kind][0] : "—"}</td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={4} style={{ color: C.muted }}>Нікого не знайдено.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/* ── факт по переведеннях: вносить PM проєкту, що приймає людину ── */
const factText = (l) => (l.hours > 0 ? l.hours + " год" : "як заплановано");
const transferLine = (t) => (t ? "з " + fmt(t.effectiveDate) + (t.temporary ? " тимчасово до " + fmt(t.returnDate) : "") + ": " + allocText(t.from) + " → " + allocText(t.to) : "переведення видалено");
const whoConfirms = (data, lenders) => (lenders && lenders.length
  ? lenders.map((p) => p + " (" + (pmText(data.pms[p]) || "без PM — підтверджує адміністратор") + ")").join("; ")
  : "адміністратор");
const primaryBtn = { cursor: "pointer", background: C.signal, color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontWeight: 600, whiteSpace: "nowrap" };

/* Форма факту: скільки годин людина відпрацювала на проєкті або «як заплановано».
   item — елемент todo (новий запис) або запис loans (редагування). */
function FactForm({ item, data, busy, act, onDone }) {
  const [hours, setHours] = useState(item.id && item.hours > 0 ? String(item.hours) : "");
  const [comment, setComment] = useState(item.comment || "");
  const norm = normHours(item.periodKey);
  const h = Number(hours);
  const share = norm && h > 0 ? Math.round((h * 1000) / norm) / 10 : 0;
  const lenders = item.lenders || item.lenderProjects || [];
  const send = async (asPlanned) => {
    const ok = await act({ action: "loan-save", id: item.id || undefined, transferId: item.transferId, project: item.project, periodKey: item.periodKey, hours: h, asPlanned, comment },
      "Надіслано на підтвердження: " + whoConfirms(data, lenders));
    if (ok && onDone) onDone();
  };
  const uid = (item.id || item.transferId + item.project + item.periodKey).replace(/[^\w-]/g, "");
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input id={"fh-" + uid} type="number" min="0" step="0.5" placeholder="годин фактично" aria-label="Годин фактично" value={hours}
          onChange={(e) => setHours(e.target.value)} style={{ width: 150 }} />
        <span className="num" style={{ fontSize: 12.5, color: C.muted }}>норма періоду {norm} год{share ? " · ≈ " + share + "% від норми" : ""}</span>
        <input type="text" placeholder="коментар (необов'язково)" aria-label="Коментар" value={comment} onChange={(e) => setComment(e.target.value)} style={{ flex: "1 1 220px" }} />
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button style={{ ...primaryBtn, opacity: busy || !(h > 0) ? 0.5 : 1 }} disabled={busy || !(h > 0)} onClick={() => send(false)}>Надіслати на підтвердження</button>
        <button className="ghost" disabled={busy} onClick={() => send(true)} title="Людина відпрацювала стільки, скільки передбачає переведення">Як заплановано</button>
        {onDone && <button className="link" onClick={onDone}>скасувати</button>}
        <span style={{ fontSize: 12, color: C.muted }}>Підтверджує: {whoConfirms(data, lenders)}</span>
      </div>
    </div>
  );
}

function DueBadge({ periodKey, today }) {
  const left = daysBetween(today, dueOf(periodKey));
  if (left >= 3) return null;
  const late = left < 0;
  return <Pill v={[late ? "прострочено на " + -left + " дн." : left === 0 ? "внести сьогодні" : "залишилось " + left + " дн.", late ? C.stop : C.warn, late ? C.stopSoft : C.warnSoft]} />;
}

function TodoCard({ s, data, busy, act }) {
  return (
    <div style={{ border: "1px solid " + C.line, borderRadius: 10, padding: 14, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <b>{s.employeeName}</b>
        <span style={{ color: C.muted, fontSize: 12.5 }}>{perLabel(s.periodKey)}</span>
        <DueBadge periodKey={s.periodKey} today={data.today} />
      </div>
      <div style={{ fontSize: 13.5 }}>Переведення {transferLine(s.transfer)}</div>
      <div style={{ fontSize: 12.5, color: C.ink2 }}>
        План: <b>{s.project} {s.pct}%</b> ≈ <span className="num">{s.planHours} год</span> із {s.norm} год норми періоду
      </div>
      <FactForm item={s} data={data} busy={busy} act={act} />
    </div>
  );
}

function Facts({ data, mine, isAdmin, busy, act, card }) {
  const [editId, setEditId] = useState("");
  const list = data.loans.filter((l) => isAdmin || mine.has(l.project));
  return (
    <>
      <section style={{ ...card, padding: 16, display: "grid", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17 }}>Потрібно внести факт {data.todo.length > 0 && <span style={{ color: C.warn }}>· {data.todo.length}</span>}</h2>
          <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 12.5 }}>
            Для тимчасових і часткових переведень, які приймає ваш проєкт, після кожної завершеної половини місяця внесіть, скільки годин людина фактично відпрацювала у вас,
            або натисніть «Як заплановано». Підтверджує PM проєкту, звідки людина. Поки факту немає, тег іде за планом (переведенням). Підтверджені години змінюють тег:
            частка вашого проєкту = години ÷ усі години людини за період (з табеля, а якщо табель у відсотках — норма робочих годин), решта ділиться пропорційно.
          </p>
        </div>
        {!data.todo.length && <p style={{ margin: 0, color: C.muted }}>Нічого вносити: за завершеними періодами всі тимчасові й часткові переведення ваших проєктів уже мають факт.</p>}
        {data.todo.slice().sort((x, y) => dueOf(x.periodKey).localeCompare(dueOf(y.periodKey)) || x.employeeName.localeCompare(y.employeeName, "uk")).map((s) => <TodoCard key={s.transferId + s.project + s.periodKey} s={s} data={data} busy={busy} act={act} />)}
      </section>

      <section style={{ ...card, overflow: "hidden" }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid " + C.lineSoft }}><h2 style={{ margin: 0, fontSize: 16 }}>Внесений факт</h2></div>
        <div className="scroll">
          <table>
            <thead><tr><th>Період</th><th>Людина</th><th>Переведення</th><th>Факт</th><th>Статус</th><th /></tr></thead>
            <tbody>
              {list.map((l) => (
                <React.Fragment key={l.id}>
                  <tr>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{perLabel(l.periodKey)}</td>
                    <td>{l.employeeName}{l.comment && <div style={{ fontSize: 12, color: C.muted }}>{l.comment}</div>}</td>
                    <td style={{ fontSize: 12.5 }}>{transferLine(l.transfer)}<div style={{ color: C.muted }}>підтверджує {whoConfirms(data, l.lenderProjects)}</div></td>
                    <td className="num"><b>{l.project}</b>: {factText(l)}{l.hours > 0 && <div style={{ fontSize: 12, color: C.muted }}>≈ {Math.round((l.hours * 1000) / normHours(l.periodKey)) / 10}% норми{l.planHours ? ", план ≈ " + l.planHours + " год" : ""}</div>}</td>
                    <td><Pill v={LOAN[l.status]} />{l.stale && <div style={{ fontSize: 12, color: C.warn, marginTop: 4 }}>переведення змінили — запис не впливає на теги</div>}{l.decidedBy && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{l.decidedBy}, {fmtDT(l.decidedAt)}{l.decisionComment ? " · «" + l.decisionComment + "»" : ""}</div>}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {l.status !== "confirmed" && <button className="link" onClick={() => setEditId(editId === l.id ? "" : l.id)}>змінити</button>}
                      {l.status !== "confirmed" && <> · <button className="link" style={{ color: C.stop }} disabled={busy} onClick={() => window.confirm("Прибрати запис?") && act({ action: "loan-delete", id: l.id }, "Запис прибрано")}>прибрати</button></>}
                    </td>
                  </tr>
                  {editId === l.id && (
                    <tr><td colSpan={6} style={{ background: "#F8FAFC" }}><FactForm item={l} data={data} busy={busy} act={act} onDone={() => setEditId("")} /></td></tr>
                  )}
                </React.Fragment>
              ))}
              {!list.length && <tr><td colSpan={6} style={{ color: C.muted }}>Ще нічого не внесено.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/* ── підтвердження факту: PM проєкту, звідки людина ── */
function Confirm({ data, mine, isAdmin, list, notes, setNotes, busy, act, card }) {
  const meName = String((data.me && data.me.name) || "").trim().toLowerCase();
  const own = (l) => String(l.createdBy || "").trim().toLowerCase() === meName;
  const decided = data.loans.filter((l) => l.status !== "pending" && (isAdmin || lendersOf(l).some((p) => mine.has(p)))).slice(0, 60);
  return (
    <>
      <section style={{ ...card, padding: 20, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>Факт по ваших людях на інших проєктах</h2>
          <Info style={{ flexBasis: "100%", margin: "0" }}>
            PM проєкту, який приймає людину, вніс, скільки годин вона фактично відпрацювала в нього за період. Після вашого підтвердження ці години змінять тег людини:
            частка проєкту, що приймає, стане за фактом, а решта піде вашим проєктам. Підтвердити може будь-хто з PM проєкту; власні записи підтверджувати не можна.
          </Info>
        </div>
        {!list.length && <p style={{ margin: 0, color: C.muted }}>Нічого не чекає на підтвердження.</p>}
        {list.map((l) => {
          const share = l.hours > 0 ? Math.round((l.hours * 1000) / normHours(l.periodKey)) / 10 : 0;
          return (
            <div key={l.id} style={{ border: "1px solid " + C.line, borderRadius: 10, padding: 14, display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <b>{l.employeeName}</b>
                <span style={{ color: C.muted, fontSize: 12.5 }}>{perLabel(l.periodKey)} · вніс(ла) {l.createdBy}{l.updatedAt ? ", " + fmtDT(l.updatedAt) : ""}</span>
              </div>
              <div style={{ fontSize: 12.5, color: C.ink2 }}>Переведення {transferLine(l.transfer)}</div>
              <div style={{ fontSize: 13.5 }}>
                {lendersOf(l).join(" + ")} → <b>{l.project}</b>: <b className="num">{factText(l)}</b>
                {l.hours > 0 && <span style={{ color: C.muted }}> (≈ {share}% норми {normHours(l.periodKey)} год{l.planHours ? ", за планом ≈ " + l.planHours + " год" : ""})</span>}
              </div>
              {l.comment && <div style={{ fontSize: 12.5, color: C.ink2 }}>«{l.comment}»</div>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input type="text" placeholder="коментар (для відхилення — обов'язково)" value={notes[l.id] || ""} onChange={(e) => setNotes((n) => ({ ...n, [l.id]: e.target.value }))} style={{ flex: "1 1 240px" }} />
                <button className="ghost" disabled={busy} onClick={() => act({ action: "loan-decide", id: l.id, ok: true, comment: notes[l.id] || "" }, l.hours > 0 ? "Підтверджено — години враховано в тегу" : "Підтверджено — за планом")}>Підтвердити</button>
                <button className="ghost" style={{ color: C.stop }} disabled={busy} onClick={() => act({ action: "loan-decide", id: l.id, ok: false, comment: notes[l.id] || "" }, "Відхилено")}>Відхилити</button>
              </div>
            </div>
          );
        })}
      </section>
      {decided.length > 0 && (
        <section style={{ ...card, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid " + C.lineSoft }}><h2 style={{ margin: 0, fontSize: 16 }}>Ухвалені рішення</h2></div>
          <div className="scroll">
            <table>
              <thead><tr><th>Період</th><th>Людина</th><th>Куди</th><th>Факт</th><th>Рішення</th><th /></tr></thead>
              <tbody>
                {decided.map((l) => (
                  <tr key={l.id}>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{perLabel(l.periodKey)}</td>
                    <td>{l.employeeName}</td>
                    <td>{l.project}</td>
                    <td className="num">{factText(l)}</td>
                    <td><Pill v={LOAN[l.status]} /> <span style={{ fontSize: 12, color: C.muted }}>{l.decidedBy}</span>{l.stale && <div style={{ fontSize: 12, color: C.warn, marginTop: 4 }}>переведення змінили — запис не впливає на теги</div>}</td>
                    <td>{(isAdmin || !own(l)) && <button className="link" disabled={busy} onClick={() => window.confirm("Зняти рішення? Запис знову чекатиме на підтвердження, а підтверджені години перестануть впливати на тег.") && act({ action: "loan-reopen", id: l.id }, "Рішення знято")}>зняти рішення</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/* ── історія рішень ── */
function History({ data, card }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [st, setSt] = useState("all");
  const ql = q.trim().toLowerCase();
  const list = (data.decisions || []).filter((d) => (kind === "all" || d.kind === kind) && (st === "all" || d.status === st)
    && (!ql || (d.text + " " + d.by + " " + d.project + " " + d.comment).toLowerCase().includes(ql)));
  return (
    <section style={{ ...card, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid " + C.lineSoft }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Історія рішень</h2>
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Тип" style={{ width: "auto" }}>
          <option value="all">усі типи</option><option>Переведення</option><option>Запит на людину</option><option>Години</option>
        </select>
        <select value={st} onChange={(e) => setSt(e.target.value)} aria-label="Рішення" style={{ width: "auto" }}>
          <option value="all">усі рішення</option><option value="approved">погоджено</option><option value="rejected">заперечено</option>
        </select>
        <input type="text" placeholder="пошук: людина, PM, коментар" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: "auto", width: 260 }} />
      </div>
      <div className="scroll">
        <table>
          <thead><tr><th>Коли</th><th>Тип</th><th>Що</th><th>Проєкт</th><th>Рішення</th></tr></thead>
          <tbody>
            {list.map((d, i) => (
              <tr key={i}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{d.at ? fmtDT(d.at) : "—"}</td>
                <td>{d.kind}</td>
                <td>{d.text}{d.comment && <div style={{ fontSize: 12, color: C.muted }}>«{d.comment}»</div>}</td>
                <td>{d.project}</td>
                <td><Pill v={APPR[d.status] || APPR.pending} /><div style={{ fontSize: 12, color: C.muted }}>{d.by}</div></td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={5} style={{ color: C.muted }}>Рішень поки немає.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}


/* ── заявка на переведення ── */
function Request({ data, busy, act, card, addBtn, label }) {
  const [who, setWho] = useState("");
  const [rows, setRows] = useState([{ project: data.myProjects[0] || "", percent: 100 }]);
  const [date, setDate] = useState(data.today);
  const [temporary, setTemporary] = useState(false);
  const [ret, setRet] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const emp = data.people.find((p) => p.name.toLowerCase() === who.trim().toLowerCase());
  const total = rows.reduce((s, r) => s + (Number(r.percent) || 0), 0);
  const donors = (() => {
    if (!emp) return [];
    const cur = {}, nw = {};
    (emp.alloc || []).forEach((x) => { cur[x.project] = (cur[x.project] || 0) + x.percent; });
    rows.forEach((x) => { if (x.project) nw[x.project] = (nw[x.project] || 0) + (Number(x.percent) || 0); });
    return Object.keys(cur).filter((p) => (nw[p] || 0) < cur[p] - 0.01).map((p) => ({ project: p, pm: pmText((data.pms || {})[p]) }));
  })();
  const send = async () => {
    const ok = await act({ action: "request", employeeId: emp ? emp.id : "", alloc: rows.map((r) => ({ project: r.project, percent: Number(r.percent) })), effectiveDate: date, temporary, returnDate: ret, reason, note },
      "Заявку надіслано адміністратору");
    if (ok) { setWho(""); setRows([{ project: data.myProjects[0] || "", percent: 100 }]); setNote(""); setReason(""); setTemporary(false); setRet(""); }
  };
  return (
    <>
      <section style={{ ...card, padding: 16, display: "grid", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17 }}>Заявка на переведення</h2>
          <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 12.5 }}>Спершу заявку погоджує PM проєкту, з якого просять людину (якщо це не ви), потім її розглядає адміністратор і створює переведення. Статус видно нижче.</p>
        </div>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "end" }}>
          <div>
            <label style={label} htmlFor="rq-who">Кого переводимо</label>
            <input id="rq-who" type="text" list="rq-people" value={who} onChange={(e) => setWho(e.target.value)} placeholder="почніть вводити ім'я" style={{ width: "100%" }} />
            <datalist id="rq-people">{data.people.map((p) => <option key={p.id} value={p.name}>{allocText(p.alloc)}</option>)}</datalist>
            {emp && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>зараз: {allocText(emp.alloc)}</div>}
            {emp && (data.futureMoves || {})[emp.id] && (
              <div style={{ fontSize: 12, color: C.warn, marginTop: 4 }}>
                Вже є переведення: {data.futureMoves[emp.id].map((m) => "з " + fmt(m.effective) + " → " + allocText(m.to) + (m.temporary ? " (до " + fmt(m.returnDate) + ")" : "")).join("; ")}. Перевірте, щоб заявка не суперечила.
              </div>
            )}
          </div>
          <div>
            <label style={label} htmlFor="rq-date">З дати</label>
            <input id="rq-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: "100%" }} />
          </div>
          <div>
            <label style={{ ...label, display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={temporary} onChange={(e) => setTemporary(e.target.checked)} /> тимчасово, до</label>
            <input type="date" value={ret} disabled={!temporary} onChange={(e) => setRet(e.target.value)} style={{ width: "100%" }} aria-label="Дата повернення" />
          </div>
        </div>
        <div>
          <span style={label}>Новий розподіл</span>
          <div style={{ display: "grid", gap: 6 }}>
            {rows.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <select value={r.project} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, project: e.target.value } : x)))} aria-label="Проєкт" style={{ minWidth: 220 }}>
                  <option value="">— проєкт —</option>
                  {data.projects.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <input type="number" min="0" max="100" value={r.percent} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} style={{ width: 90 }} aria-label="Відсоток" />
                <span style={{ color: C.muted }}>%</span>
                {rows.length > 1 && <button className="link" onClick={() => setRows(rows.filter((_, j) => j !== i))}>прибрати</button>}
              </div>
            ))}
            <div style={{ display: "flex", gap: 14 }}>
              <button className="link" onClick={() => setRows([...rows, { project: "", percent: 0 }])}>+ проєкт</button>
              <span className="num" style={{ fontSize: 12.5, color: Math.abs(total - 100) < 0.01 ? C.muted : C.stop }}>разом {total}%</span>
            </div>
          </div>
        </div>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <div>
            <label style={label} htmlFor="rq-r">Підстава</label>
            <input id="rq-r" type="text" list="rq-reasons" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: "100%" }} />
            <datalist id="rq-reasons">{data.reasons.map((r) => <option key={r} value={r} />)}</datalist>
          </div>
          <div>
            <label style={label} htmlFor="rq-n">Коментар</label>
            <input id="rq-n" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="з ким погоджено, деталі" style={{ width: "100%" }} />
          </div>
        </div>
        {donors.length > 0 && (
          <div style={{ fontSize: 12.5, color: C.ink2, background: C.planSoft, borderRadius: 8, padding: "8px 12px" }}>
            Погодить: {donors.map((d) => d.project + (d.pm ? " (" + d.pm + ")" : " (PM не вказано)")).join("; ")}. Там, де ви PM, погоджено автоматично.
          </div>
        )}
        <div>
          <button style={{ ...addBtn, opacity: busy || !emp || Math.abs(total - 100) > 0.01 ? 0.5 : 1 }} disabled={busy || !emp || Math.abs(total - 100) > 0.01} onClick={send}>Надіслати заявку</button>
        </div>
      </section>
      {data.requests.length > 0 && (
        <section style={{ ...card, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid " + C.lineSoft }}><h2 style={{ margin: 0, fontSize: 16 }}>Заявки мої й колег-PM</h2></div>
          <div className="scroll">
            <table>
              <thead><tr><th>Подано</th><th>Людина</th><th>Розподіл</th><th>З дати</th><th>Статус</th></tr></thead>
              <tbody>
                {data.requests.map((r) => (
                  <tr key={r.id}>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDT(r.createdAt)}{!r.own && <div style={{ fontSize: 12, color: C.muted }}>подав(ла) {r.requester}</div>}</td>
                    <td>{r.employee}</td>
                    <td>{allocText(r.alloc)}</td>
                    <td className="num">{fmt(r.effectiveDate)}{r.temporary ? " – " + fmt(r.returnDate) : ""}</td>
                    <td><Pill v={REQ[r.status] || REQ.new} />{r.status === "new" && (r.approvals || []).some((a) => a.role === "give") && (
                      <div style={{ fontSize: 12, marginTop: 4, display: "grid", gap: 2 }}>
                        {(r.approvals || []).filter((a) => a.role === "give").map((a) => (
                          <span key={a.project} style={{ color: (APPR[a.status] || APPR.pending)[1] }}>{a.project}: {(APPR[a.status] || APPR.pending)[0]}{a.comment && a.status === "rejected" ? " · «" + a.comment + "»" : ""}</span>
                        ))}
                      </div>
                    )}{r.comment && <div style={{ fontSize: 12, color: C.muted }}>{r.comment}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/* ── для адміністратора: увесь факт по переведеннях (вкладка «Переведення → Факт по переведеннях») ── */
export function LoansAdmin({ token, onChanged, setToast }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("pending");
  const [q, setQ] = useState("");
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState(false);
  const load = () => call(token, "GET").then(setData).catch((e) => setToast && setToast(e.message));
  useEffect(() => { load(); }, [token]);
  async function act(body, okText) {
    setBusy(true);
    try { setData(await call(token, "POST", body)); if (okText && setToast) setToast(okText); onChanged && onChanged(); return true; }
    catch (e) { setToast && setToast(e.message); return false; }
    finally { setBusy(false); }
  }
  const card = { background: C.surface, border: "1px solid " + C.line, borderRadius: 10, boxShadow: "0 1px 2px rgba(15,23,42,.04)" };
  if (!data) return <section style={{ ...card, padding: 24, color: C.muted }}>Завантажуємо…</section>;
  const ql = q.trim().toLowerCase();
  const hit = (name, project, lenders) => !ql || (name + " " + project + " " + (lenders || []).join(" ")).toLowerCase().includes(ql);
  const list = data.loans.filter((l) => (status === "all" || l.status === status) && hit(l.employeeName, l.project, l.lenderProjects));
  const todo = data.todo.filter((s) => hit(s.employeeName, s.project, s.lenders));
  const count = (k) => data.loans.filter((l) => l.status === k).length;
  return (
    <section style={{ ...card, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid " + C.lineSoft, display: "grid", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Факт по тимчасових і часткових переведеннях</h2>
        <p style={{ margin: 0, color: C.muted, fontSize: 12.5 }}>
          Переведення — це план. Після кожної завершеної половини місяця PM проєкту, що приймає людину, вносить фактично відпрацьовані години (або «як заплановано»),
          а PM проєкту, звідки людина, підтверджує (достатньо будь-кого з PM проєкту). До підтвердження тег іде за планом. Лише підтверджені години змінюють тег
          у фін. обліку й відомостях ЗП: частка проєкту, що приймає, = години ÷ усі години людини за період (з табеля в годинах, інакше норма — будні × 8),
          решта ділиться пропорційно. Закриті місяці не змінюються. Ви можете внести, підтвердити або відхилити будь-який запис.
        </p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {[["todo", "Чекають на факт · " + data.todo.length], ["pending", "Чекають на підтвердження · " + count("pending")], ["confirmed", "Підтверджені · " + count("confirmed")], ["rejected", "Відхилені · " + count("rejected")], ["all", "Усі внесені"]].map(([k, l]) => (
            <button key={k} className="ghost" aria-pressed={status === k} onClick={() => setStatus(k)}
              style={{ background: status === k ? C.ink : C.surface, color: status === k ? "#fff" : C.ink2 }}>{l}</button>
          ))}
          <input type="text" placeholder="пошук" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: "auto", width: 220 }} />
        </div>
      </div>

      {status === "todo" ? (
        <div style={{ padding: 20, display: "grid", gap: 12 }}>
          {!todo.length && <p style={{ margin: 0, color: C.muted }}>{ql ? "Нічого не знайдено." : "Усі завершені періоди мають факт."}</p>}
          {todo.map((s) => <TodoCard key={s.transferId + s.project + s.periodKey} s={s} data={data} busy={busy} act={act} />)}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Період</th><th>Людина</th><th>Переведення</th><th>Факт</th><th>Вніс</th><th>Статус</th><th /></tr></thead>
            <tbody>
              {list.map((l) => (
                <tr key={l.id}>
                  <td className="num" style={{ whiteSpace: "nowrap" }}>{perLabel(l.periodKey)}</td>
                  <td>{l.employeeName}{l.comment && <div style={{ fontSize: 12, color: C.muted }}>«{l.comment}»</div>}</td>
                  <td style={{ fontSize: 12.5 }}>{transferLine(l.transfer)}<div style={{ color: C.muted }}>підтверджує {whoConfirms(data, l.lenderProjects)}</div></td>
                  <td className="num"><b>{l.project}</b>: {factText(l)}<div style={{ fontSize: 12, color: C.muted }}>норма {normHours(l.periodKey)}{l.planHours ? ", план ≈ " + l.planHours : ""}</div></td>
                  <td style={{ fontSize: 12.5 }}>{l.createdBy}<div style={{ color: C.muted }}>{fmtDT(l.updatedAt)}</div></td>
                  <td><Pill v={LOAN[l.status]} />{l.stale && <div style={{ fontSize: 12, color: C.warn, marginTop: 4 }}>переведення змінили — запис не впливає на теги</div>}{l.decidedBy && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{l.decidedBy}{l.decisionComment ? " · «" + l.decisionComment + "»" : ""}</div>}</td>
                  <td style={{ minWidth: 230 }}>
                    {l.status === "pending" ? (
                      <div style={{ display: "grid", gap: 6 }}>
                        <input type="text" placeholder="коментар" value={notes[l.id] || ""} onChange={(e) => setNotes((n) => ({ ...n, [l.id]: e.target.value }))} />
                        <div style={{ display: "flex", gap: 10 }}>
                          <button className="link" disabled={busy} onClick={() => act({ action: "loan-decide", id: l.id, ok: true, comment: notes[l.id] || "" }, "Підтверджено")}>підтвердити</button>
                          <button className="link" disabled={busy} style={{ color: C.stop }} onClick={() => act({ action: "loan-decide", id: l.id, ok: false, comment: notes[l.id] || "" }, "Відхилено")}>відхилити</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 10 }}>
                        <button className="link" disabled={busy} onClick={() => act({ action: "loan-reopen", id: l.id }, "Рішення знято")}>зняти рішення</button>
                        <button className="link" disabled={busy} style={{ color: C.stop }} onClick={() => window.confirm("Видалити запис назавжди?") && act({ action: "loan-delete", id: l.id }, "Видалено")}>видалити</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={7} style={{ color: C.muted }}>Записів немає.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
