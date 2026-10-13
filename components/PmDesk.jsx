"use client";
/* Робоче місце PM. Дані приходять з /api/pm — лише проєкти, де ім'я людини стоїть
   у полі «PM, який погоджує». Тут PM:
     • погоджує або заперечує переведення, що стосуються його проєктів;
     • бачить людей своїх проєктів;
     • вносить фактично відпрацьовані години людей, яких його проєкт позичив;
     • підтверджує години своїх людей, яких позичили інші (лише підтверджені впливають на теги);
     • подає заявку на переведення. */
import React, { useState, useEffect, useMemo } from "react";
import { normHours } from "../lib/loans";

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
  const [tab, setTab] = useState("approve");
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

  const mine = useMemo(() => new Set((data && data.myProjects) || []), [data]);
  const isAdmin = data && data.me.role === "admin";
  const pendingApprovals = data ? data.approvals.filter((t) => t.approvals.some((a) => mine.has(a.project) && a.status === "pending")) : [];
  const toConfirm = data ? data.loans.filter((l) => l.status === "pending" && (mine.has(l.lenderProject) || isAdmin)) : [];

  const card = { background: C.surface, border: "1px solid " + C.line, borderRadius: 10, boxShadow: "0 1px 2px rgba(15,23,42,.04)" };
  const addBtn = { cursor: "pointer", background: C.signal, color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontWeight: 600, whiteSpace: "nowrap" };
  const label = { fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 6, display: "block" };
  const css = `
    .pm *, .pm *::before, .pm *::after { box-sizing: border-box; }
    .pm button, .pm input, .pm select, .pm textarea { font: inherit; color: inherit; }
    .pm input[type=text], .pm input[type=number], .pm input[type=date], .pm select, .pm textarea { border: 1px solid ${C.line}; border-radius: 8px; padding: 7px 9px; background: #fff; min-height: 36px; }
    .pm :focus-visible { outline: 2px solid ${C.signal}; outline-offset: 2px; border-radius: 6px; }
    .pm table { border-collapse: separate; border-spacing: 0; width: 100%; }
    .pm th, .pm td { text-align: left; padding: 10px 14px; vertical-align: top; }
    .pm th { font-size: 11.5px; font-weight: 600; color: ${C.muted}; text-transform: uppercase; letter-spacing: .04em; background: #F8FAFC; border-bottom: 1px solid ${C.line}; }
    .pm td { border-bottom: 1px solid ${C.lineSoft}; font-size: 13.5px; }
    .pm .num { font-variant-numeric: tabular-nums; }
    .pm .ghost { cursor: pointer; background: ${C.surface}; border: 1px solid ${C.line}; border-radius: 8px; padding: 8px 13px; color: ${C.ink2}; font-weight: 500; }
    .pm .ghost:hover { border-color: #CBD5E1; background: #F8FAFC; color: ${C.ink}; }
    .pm .link { cursor: pointer; background: none; border: none; padding: 0; color: ${C.signal}; font-weight: 500; }
    .pm .link:hover { text-decoration: underline; }
    .pm .bar { background: #0B1733; color: #C7D2E4; }
    .pm .logo { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; font-weight: 700; color: #fff; background: linear-gradient(135deg, #3B82F6, #1D4ED8); }
    .pm .tabs { display: flex; gap: 4px; flex-wrap: wrap; }
    .pm .tab { cursor: pointer; border: none; background: transparent; padding: 9px 14px; border-radius: 8px; color: ${C.ink2}; }
    .pm .tab.on { background: ${C.ink}; color: #fff; font-weight: 600; }
    .pm .badge { background: ${C.warn}; color: #fff; border-radius: 999px; padding: 0 7px; font-size: 11.5px; margin-left: 6px; }
    .pm .scroll { overflow-x: auto; }
    @media (max-width: 640px) { .pm main { padding: 16px !important; } .pm th, .pm td { padding: 8px 10px; } }
  `;

  const TABS = [
    ["approve", "Погодження", pendingApprovals.length],
    ["people", "Люди проєктів", 0],
    ["loans", "Позичені години", 0],
    ["confirm", "Підтвердити години", toConfirm.length],
    ["request", "Заявка на переведення", 0],
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

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: 24, display: "grid", gap: 18 }}>
        {!data && <section style={{ ...card, padding: 30, color: C.muted }}>Завантажуємо…</section>}

        {data && !data.myProjects.length && !isAdmin && (
          <section style={{ ...card, padding: 24 }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>За вами поки не закріплено жодного проєкту</h2>
            <p style={{ color: C.ink2, marginBottom: 0 }}>
              Попросіть адміністратора вписати «{user.name}» у поле «PM, який погоджує» потрібного проєкту (Довідник → Проєкти). Ім'я має збігатися буква в букву.
              Поки що ви можете подати заявку на переведення.
            </p>
          </section>
        )}

        {data && (
          <section style={{ ...card, padding: 6 }}>
            <nav className="tabs" aria-label="Розділи">
              {TABS.map(([k, l, n]) => (
                <button key={k} className={"tab" + (tab === k ? " on" : "")} aria-current={tab === k} onClick={() => setTab(k)}>
                  {l}{n ? <span className="badge">{n}</span> : null}
                </button>
              ))}
            </nav>
          </section>
        )}

        {data && tab === "approve" && <Approvals data={data} mine={mine} notes={notes} setNotes={setNotes} busy={busy} act={act} card={card} />}
        {data && tab === "people" && <People data={data} mine={mine} q={q} setQ={setQ} card={card} />}
        {data && tab === "loans" && <Loans data={data} mine={mine} isAdmin={isAdmin} busy={busy} act={act} card={card} addBtn={addBtn} label={label} />}
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

/* ── погодження ── */
function Approvals({ data, mine, notes, setNotes, busy, act, card }) {
  const [onlyPending, setOnlyPending] = useState(true);
  const list = data.approvals.filter((t) => !onlyPending || t.approvals.some((a) => mine.has(a.project) && a.status === "pending"));
  return (
    <section style={{ ...card, padding: 20, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Переведення ваших проєктів</h2>
        <label style={{ fontSize: 13, color: C.ink2, marginLeft: "auto" }}>
          <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} /> лише ті, що чекають на вас
        </label>
      </div>
      <p style={{ margin: 0, color: C.muted, fontSize: 12.5 }}>
        Переведення діє з дати незалежно від погодження — ви підтверджуєте вже доконане. {data.approvalMode === "both"
          ? "Погоджують обидві сторони: і той, хто віддає, і той, хто приймає."
          : "Обов'язкове слово того, хто віддає людину; той, хто приймає, бачить запис до відома."}
      </p>
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
  );
}

/* ── люди проєктів ── */
function People({ data, mine, q, setQ, card }) {
  const on = new Set(data.onMine);
  const ql = q.trim().toLowerCase();
  const rows = data.people.filter((p) => on.has(p.id) && (!ql || (p.name + " " + p.position).toLowerCase().includes(ql)));
  const fte = {};
  data.people.filter((p) => on.has(p.id)).forEach((p) => p.alloc.forEach((r) => { if (mine.has(r.project)) fte[r.project] = (fte[r.project] || 0) + r.percent / 100; }));
  return (
    <section style={{ ...card, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid " + C.lineSoft }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Люди на ваших проєктах сьогодні</h2>
        <span className="num" style={{ color: C.muted, fontSize: 13 }}>{Object.entries(fte).map(([p, v]) => p + ": " + Number(v.toFixed(2)) + " ставки").join(" · ")}</span>
        <input type="text" placeholder="пошук" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: "auto", width: 220 }} />
      </div>
      <div className="scroll">
        <table>
          <thead><tr><th>Людина</th><th>Посада</th><th>Розподіл</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td style={{ color: C.ink2 }}>{p.position || "—"}</td>
                <td>{p.alloc.map((r, i) => <span key={r.project} style={{ fontWeight: mine.has(r.project) ? 600 : 400, color: mine.has(r.project) ? C.ink : C.muted }}>{i ? " + " : ""}{r.project} {Number(r.percent.toFixed(2))}%</span>)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={3} style={{ color: C.muted }}>Нікого не знайдено.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ── позичені години: вносить PM, який позичив ── */
function Loans({ data, mine, isAdmin, busy, act, card, addBtn, label }) {
  const myList = isAdmin ? [...mine] : data.myProjects;
  const projOptions = isAdmin ? data.projects : myList;
  const blank = () => ({ id: "", employeeId: "", project: projOptions[0] || "", periodKey: keyOf(perOfDate(data.today)), hours: "", lenderProject: "", comment: "" });
  const [f, setF] = useState(blank);
  const [who, setWho] = useState("");
  const emp = data.people.find((p) => p.id === f.employeeId);
  const norm = /^\d{4}-\d{2}-H[12]$/.test(f.periodKey) ? normHours(f.periodKey) : 0;
  const share = norm && Number(f.hours) > 0 ? Math.round((Number(f.hours) * 1000) / norm) / 10 : 0;
  const list = data.loans.filter((l) => isAdmin || mine.has(l.project));
  const pick = (name) => {
    setWho(name);
    const p = data.people.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    setF((x) => ({ ...x, employeeId: p ? p.id : "" }));
  };
  const edit = (l) => { setF({ id: l.id, employeeId: l.employeeId, project: l.project, periodKey: l.periodKey, hours: String(l.hours), lenderProject: l.lenderProject, comment: l.comment || "" }); setWho(l.employeeName); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const save = async () => {
    if (!f.employeeId) return;
    const ok = await act({ action: "loan-save", ...f, hours: Number(f.hours) }, f.id ? "Запис оновлено — чекає на підтвердження" : "Години внесено — чекають на підтвердження PM проєкту, звідки людина");
    if (ok) { setF(blank()); setWho(""); }
  };
  const lenders = emp ? emp.alloc.map((r) => r.project).filter((p) => p !== f.project) : [];

  return (
    <>
      <section style={{ ...card, padding: 20, display: "grid", gap: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17 }}>{f.id ? "Редагувати години" : "Внести фактично відпрацьовані години"}</h2>
          <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 12.5 }}>
            Якщо ваш проєкт позичав людину з іншого проєкту без переведення, внесіть, скільки годин вона фактично відпрацювала у вас за половину місяця.
            Запис іде на підтвердження PM проєкту, звідки людина. Лише після підтвердження години змінюють тег людини за цей період:
            частка вашого проєкту = години ÷ усі години людини за період (з табеля, а якщо табель у відсотках — норма робочих годин).
          </p>
        </div>
        {!projOptions.length ? <p style={{ margin: 0, color: C.warn }}>За вами немає проєктів — вносити години нема від чийого імені.</p> : (
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", alignItems: "end" }}>
            <div>
              <label style={label} htmlFor="ln-who">Кого позичили</label>
              <input id="ln-who" type="text" list="ln-people" value={who} onChange={(e) => pick(e.target.value)} placeholder="почніть вводити ім'я" style={{ width: "100%" }} />
              <datalist id="ln-people">{data.people.map((p) => <option key={p.id} value={p.name}>{allocText(p.alloc)}</option>)}</datalist>
              {emp && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>зараз: {allocText(emp.alloc)}</div>}
            </div>
            <div>
              <label style={label} htmlFor="ln-proj">На ваш проєкт</label>
              <select id="ln-proj" value={f.project} onChange={(e) => setF((x) => ({ ...x, project: e.target.value }))} style={{ width: "100%" }}>
                {projOptions.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label style={label}>Період</label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button className="ghost" onClick={() => setF((x) => ({ ...x, periodKey: shift(x.periodKey, -1) }))} aria-label="Попередній період">←</button>
                <span className="num" style={{ fontWeight: 600, flex: 1, textAlign: "center", fontSize: 13 }}>{perLabel(f.periodKey)}</span>
                <button className="ghost" onClick={() => setF((x) => ({ ...x, periodKey: shift(x.periodKey, 1) }))} aria-label="Наступний період">→</button>
              </div>
            </div>
            <div>
              <label style={label} htmlFor="ln-h">Годин фактично</label>
              <input id="ln-h" type="number" min="0" step="0.5" value={f.hours} onChange={(e) => setF((x) => ({ ...x, hours: e.target.value }))} style={{ width: "100%" }} />
              <div className="num" style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>норма періоду {norm} год{share ? " · ≈ " + share + "% від норми" : ""}</div>
            </div>
            <div>
              <label style={label} htmlFor="ln-from">Звідки позичили</label>
              <select id="ln-from" value={f.lenderProject} onChange={(e) => setF((x) => ({ ...x, lenderProject: e.target.value }))} style={{ width: "100%" }}>
                <option value="">визначити автоматично</option>
                {[...new Set([...lenders, ...data.projects.filter((p) => p !== f.project)])].map((p) => <option key={p} value={p}>{p}{data.pms[p] ? " · PM " + data.pms[p] : " · без PM"}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={label} htmlFor="ln-c">Коментар</label>
              <input id="ln-c" type="text" value={f.comment} onChange={(e) => setF((x) => ({ ...x, comment: e.target.value }))} placeholder="над чим працювала людина, домовленість тощо" style={{ width: "100%" }} />
            </div>
            <div style={{ display: "flex", gap: 10, gridColumn: "1 / -1" }}>
              <button style={{ ...addBtn, opacity: busy || !f.employeeId || !(Number(f.hours) > 0) ? 0.5 : 1 }} disabled={busy || !f.employeeId || !(Number(f.hours) > 0)} onClick={save}>
                {f.id ? "Зберегти й надіслати на підтвердження" : "Надіслати на підтвердження"}
              </button>
              {f.id && <button className="ghost" onClick={() => { setF(blank()); setWho(""); }}>Скасувати</button>}
            </div>
          </div>
        )}
      </section>

      <section style={{ ...card, overflow: "hidden" }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid " + C.lineSoft }}><h2 style={{ margin: 0, fontSize: 16 }}>Внесені години</h2></div>
        <div className="scroll">
          <table>
            <thead><tr><th>Період</th><th>Людина</th><th>Звідки → куди</th><th>Годин</th><th>Статус</th><th /></tr></thead>
            <tbody>
              {list.map((l) => (
                <tr key={l.id}>
                  <td className="num" style={{ whiteSpace: "nowrap" }}>{perLabel(l.periodKey)}</td>
                  <td>{l.employeeName}{l.comment && <div style={{ fontSize: 12, color: C.muted }}>{l.comment}</div>}</td>
                  <td>{l.lenderProject} → <b>{l.project}</b><div style={{ fontSize: 12, color: C.muted }}>підтверджує {data.pms[l.lenderProject] || "адміністратор (у проєкту немає PM)"}</div></td>
                  <td className="num">{l.hours}</td>
                  <td><Pill v={LOAN[l.status]} />{l.decidedBy && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{l.decidedBy}, {fmtDT(l.decidedAt)}{l.decisionComment ? " · «" + l.decisionComment + "»" : ""}</div>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {l.status !== "confirmed" && <button className="link" onClick={() => edit(l)}>змінити</button>}
                    {l.status !== "confirmed" && <> · <button className="link" style={{ color: C.stop }} disabled={busy} onClick={() => window.confirm("Прибрати запис?") && act({ action: "loan-delete", id: l.id }, "Запис прибрано")}>прибрати</button></>}
                  </td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={6} style={{ color: C.muted }}>Ще нічого не внесено.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/* ── підтвердження годин: PM проєкту, звідки людина ── */
function Confirm({ data, mine, isAdmin, list, notes, setNotes, busy, act, card }) {
  const decided = data.loans.filter((l) => l.status !== "pending" && (mine.has(l.lenderProject) || isAdmin)).slice(0, 60);
  return (
    <>
      <section style={{ ...card, padding: 20, display: "grid", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17 }}>Години ваших людей на інших проєктах</h2>
          <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 12.5 }}>
            Інший PM вніс, скільки годин людина з вашого проєкту фактично відпрацювала в нього. Після вашого підтвердження ці години змінять тег людини за період:
            частка іншого проєкту зросте, а частки ваших проєктів пропорційно зменшаться.
          </p>
        </div>
        {!list.length && <p style={{ margin: 0, color: C.muted }}>Нічого не чекає на підтвердження.</p>}
        {list.map((l) => {
          const share = Math.round((l.hours * 1000) / normHours(l.periodKey)) / 10;
          return (
            <div key={l.id} style={{ border: "1px solid " + C.line, borderRadius: 10, padding: 14, display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <b>{l.employeeName}</b>
                <span style={{ color: C.muted, fontSize: 12.5 }}>{perLabel(l.periodKey)} · вніс(ла) {l.createdBy}{l.updatedAt ? ", " + fmtDT(l.updatedAt) : ""}</span>
              </div>
              <div style={{ fontSize: 13.5 }}>
                {l.lenderProject} → <b>{l.project}</b>: <b className="num">{l.hours} год</b>
                <span style={{ color: C.muted }}> (≈ {share}% норми {normHours(l.periodKey)} год)</span>
              </div>
              {l.comment && <div style={{ fontSize: 12.5, color: C.ink2 }}>«{l.comment}»</div>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input type="text" placeholder="коментар (для відхилення — обов'язково)" value={notes[l.id] || ""} onChange={(e) => setNotes((n) => ({ ...n, [l.id]: e.target.value }))} style={{ flex: "1 1 240px" }} />
                <button className="ghost" disabled={busy} onClick={() => act({ action: "loan-decide", id: l.id, ok: true, comment: notes[l.id] || "" }, "Підтверджено — години враховано в тегу")}>Підтвердити</button>
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
              <thead><tr><th>Період</th><th>Людина</th><th>Куди</th><th>Годин</th><th>Рішення</th><th /></tr></thead>
              <tbody>
                {decided.map((l) => (
                  <tr key={l.id}>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{perLabel(l.periodKey)}</td>
                    <td>{l.employeeName}</td>
                    <td>{l.project}</td>
                    <td className="num">{l.hours}</td>
                    <td><Pill v={LOAN[l.status]} /> <span style={{ fontSize: 12, color: C.muted }}>{l.decidedBy}</span></td>
                    <td><button className="link" disabled={busy} onClick={() => window.confirm("Зняти рішення? Запис знову чекатиме на підтвердження, а підтверджені години перестануть впливати на тег.") && act({ action: "loan-reopen", id: l.id }, "Рішення знято")}>зняти рішення</button></td>
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
  const send = async () => {
    const ok = await act({ action: "request", employeeId: emp ? emp.id : "", alloc: rows.map((r) => ({ project: r.project, percent: Number(r.percent) })), effectiveDate: date, temporary, returnDate: ret, reason, note },
      "Заявку надіслано адміністратору");
    if (ok) { setWho(""); setRows([{ project: data.myProjects[0] || "", percent: 100 }]); setNote(""); setReason(""); setTemporary(false); setRet(""); }
  };
  return (
    <>
      <section style={{ ...card, padding: 20, display: "grid", gap: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17 }}>Заявка на переведення</h2>
          <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 12.5 }}>Заявка потрапляє адміністратору у «Заявки». Переведення створює адміністратор; статус заявки видно нижче.</p>
        </div>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "end" }}>
          <div>
            <label style={label} htmlFor="rq-who">Кого переводимо</label>
            <input id="rq-who" type="text" list="rq-people" value={who} onChange={(e) => setWho(e.target.value)} placeholder="почніть вводити ім'я" style={{ width: "100%" }} />
            <datalist id="rq-people">{data.people.map((p) => <option key={p.id} value={p.name}>{allocText(p.alloc)}</option>)}</datalist>
            {emp && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>зараз: {allocText(emp.alloc)}</div>}
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
        <div>
          <button style={{ ...addBtn, opacity: busy || !emp || Math.abs(total - 100) > 0.01 ? 0.5 : 1 }} disabled={busy || !emp || Math.abs(total - 100) > 0.01} onClick={send}>Надіслати заявку</button>
        </div>
      </section>
      {data.requests.length > 0 && (
        <section style={{ ...card, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid " + C.lineSoft }}><h2 style={{ margin: 0, fontSize: 16 }}>Мої заявки</h2></div>
          <div className="scroll">
            <table>
              <thead><tr><th>Подано</th><th>Людина</th><th>Розподіл</th><th>З дати</th><th>Статус</th></tr></thead>
              <tbody>
                {data.requests.map((r) => (
                  <tr key={r.id}>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDT(r.createdAt)}</td>
                    <td>{r.employee}</td>
                    <td>{allocText(r.alloc)}</td>
                    <td className="num">{fmt(r.effectiveDate)}{r.temporary ? " – " + fmt(r.returnDate) : ""}</td>
                    <td><Pill v={REQ[r.status] || REQ.new} />{r.comment && <div style={{ fontSize: 12, color: C.muted }}>{r.comment}</div>}</td>
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

/* ── для адміністратора: усі записи позичання (вкладка «Переведення → Позичання годин») ── */
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
    try { setData(await call(token, "POST", body)); if (okText && setToast) setToast(okText); onChanged && onChanged(); }
    catch (e) { setToast && setToast(e.message); }
    finally { setBusy(false); }
  }
  const card = { background: C.surface, border: "1px solid " + C.line, borderRadius: 10, boxShadow: "0 1px 2px rgba(15,23,42,.04)" };
  if (!data) return <section style={{ ...card, padding: 24, color: C.muted }}>Завантажуємо…</section>;
  const ql = q.trim().toLowerCase();
  const list = data.loans.filter((l) => (status === "all" || l.status === status) && (!ql || (l.employeeName + " " + l.project + " " + l.lenderProject).toLowerCase().includes(ql)));
  const count = (k) => data.loans.filter((l) => l.status === k).length;
  return (
    <section style={{ ...card, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid " + C.lineSoft, display: "grid", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Позичання годин між проєктами</h2>
        <p style={{ margin: 0, color: C.muted, fontSize: 12.5 }}>
          PM проєкту, який позичив людину, вносить фактично відпрацьовані години за половину місяця; PM проєкту, звідки людина, підтверджує.
          Лише підтверджені години змінюють тег у фін. обліку й відомостях ЗП: частка проєкту-позичальника = години ÷ усі години людини за період
          (з табеля в годинах, інакше норма — будні × 8), решта ділиться пропорційно звичайному розподілу. Закриті місяці не змінюються.
          Ви можете підтвердити або відхилити будь-який запис.
        </p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {[["pending", "Чекають · " + count("pending")], ["confirmed", "Підтверджені · " + count("confirmed")], ["rejected", "Відхилені · " + count("rejected")], ["all", "Усі"]].map(([k, l]) => (
            <button key={k} className="ghost" aria-pressed={status === k} onClick={() => setStatus(k)}
              style={{ background: status === k ? C.ink : C.surface, color: status === k ? "#fff" : C.ink2 }}>{l}</button>
          ))}
          <input type="text" placeholder="пошук" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: "auto", width: 220 }} />
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>Період</th><th>Людина</th><th>Звідки → куди</th><th>Годин</th><th>Вніс</th><th>Статус</th><th /></tr></thead>
          <tbody>
            {list.map((l) => (
              <tr key={l.id}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{perLabel(l.periodKey)}</td>
                <td>{l.employeeName}{l.comment && <div style={{ fontSize: 12, color: C.muted }}>«{l.comment}»</div>}</td>
                <td>{l.lenderProject} → <b>{l.project}</b><div style={{ fontSize: 12, color: C.muted }}>підтверджує {data.pms[l.lenderProject] || "адміністратор"}</div></td>
                <td className="num">{l.hours}<div style={{ fontSize: 12, color: C.muted }}>норма {normHours(l.periodKey)}</div></td>
                <td style={{ fontSize: 12.5 }}>{l.createdBy}<div style={{ color: C.muted }}>{fmtDT(l.updatedAt)}</div></td>
                <td><Pill v={LOAN[l.status]} />{l.decidedBy && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{l.decidedBy}{l.decisionComment ? " · «" + l.decisionComment + "»" : ""}</div>}</td>
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
    </section>
  );
}
