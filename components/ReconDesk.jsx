"use client";
/* Звірка PM: план за Allocate проти годин з трекерів. Дані — з /api/recon.
   PM бачить рядки лише своїх проєктів, обирає рішення по відхиленнях і підтверджує звірку.
   Адміністратор додатково завантажує години (тестове джерело) і задає допуск. */
import React, { useState, useEffect, useCallback } from "react";
import Info from "./Info";

const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const pad = (n) => String(n).padStart(2, "0");
const lastDay = (y, m) => new Date(y, m, 0).getDate();
const label = (k) => { const y = +k.slice(0, 4), m = +k.slice(5, 7); return MONTHS[m - 1] + " " + y + ", " + (k.endsWith("H1") ? "01–15" : "16–" + lastDay(y, m)); };
const prevKey = (k) => {
  if (k.endsWith("H2")) return k.slice(0, 7) + "-H1";
  const y = +k.slice(0, 4), m = +k.slice(5, 7);
  return (m === 1 ? y - 1 + "-12" : y + "-" + pad(m - 1)) + "-H2";
};
const nextKey = (k) => {
  if (k.endsWith("H1")) return k.slice(0, 7) + "-H2";
  const y = +k.slice(0, 4), m = +k.slice(5, 7);
  return (m === 12 ? y + 1 + "-01" : y + "-" + pad(m + 1)) + "-H1";
};
const fmtDT = (s) => { const d = new Date(s); return isNaN(d) ? "—" : pad(d.getDate()) + "." + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const num = (v) => (v == null ? "—" : String(Number(v.toFixed ? v.toFixed(1) : v)).replace(".", ","));

export async function reconCall(token, method, body, period) {
  const res = await fetch("/api/recon" + (method === "GET" && period ? "?period=" + period : ""), {
    method, cache: "no-store",
    headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || "HTTP " + res.status); e.status = res.status; throw e; }
  return data;
}

export default function ReconDesk({ token, C, card, addBtn, onApiError, setToast, onChanged }) {
  const [period, setPeriod] = useState(null);
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [openRow, setOpenRow] = useState(null);
  const [form, setForm] = useState({ kind: "plan", comment: "", hours: "" });
  const [text, setText] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [cfg, setCfg] = useState(null);
  const [filter, setFilter] = useState("attn");
  const [expanded, setExpanded] = useState({});

  const run = useCallback(async (method, body, per) => {
    setBusy(true);
    try {
      const data = await reconCall(token, method, body, per || period);
      setD(data); if (!period) setPeriod(data.period);
      if (data.cfg) setCfg((c) => c || data.cfg);
      onChanged && onChanged(data);
      return data;
    } catch (e) {
      if (e.status === 401) onApiError && onApiError(e); else setToast(e.message);
      return null;
    } finally { setBusy(false); }
  }, [token, period]);

  useEffect(() => { run("GET", null, period || undefined); }, [period]);

  const post = (action, extra, okText) => run("POST", { action, period, ...extra }).then((r) => { if (r && okText) setToast(okText); return r; });

  if (!d) return <section style={{ ...card, padding: 24, color: C.muted }}>Завантажуємо…</section>;
  const isAdmin = d.me && d.me.role === "admin";
  const cur = period || d.period;
  const choices = [d.defaultPeriod, prevKey(d.defaultPeriod), nextKey(d.defaultPeriod)];
  const needsDecision = (r) => (r.state === "warn" || r.state === "nodata") && !r.res;
  const isAttn = (r) => r.state === "warn" || r.state === "nodata" || !!r.res;
  const byProject = {};
  d.rows.forEach((r) => { (byProject[r.project] = byProject[r.project] || []).push(r); });
  const sumOf = (p) => d.summary.find((s) => s.project === p) || {};
  const openCount = d.rows.filter(needsDecision).length;
  const attnCount = d.rows.filter(isAttn).length;
  const sharedCount = d.rows.filter((r) => r.shared).length;
  const confirmedCount = d.summary.filter((s) => s.state === "confirmed").length;
  const allConfirmed = d.summary.length > 0 && confirmedCount === d.summary.length;
  const canConfirm = d.finished && d.hours && d.summary.length > 0 && !openCount && !allConfirmed;
  const pass = (r) => (filter === "all" ? true : filter === "shared" ? r.shared : isAttn(r));
  const hint = allConfirmed ? "" : !d.finished ? "Період ще триває — підтвердити можна після його завершення."
    : !d.hours ? "Годин за період ще немає — їх завантажує адміністратор."
    : openCount ? "Оберіть дію по " + openCount + " відхиленнях, і тоді можна підтверджувати." : "Усе перевірено — можна підтверджувати.";

  const stateCell = (r) => {
    if (r.res) {
      const A = d.actions[r.res.action] || r.res.action;
      return <span style={{ color: C.ink2, fontSize: 12.5 }}><b>{A}</b>{r.res.action === "manual" ? " · " + num(r.res.hours) + " год" : ""} · «{r.res.comment}»</span>;
    }
    if (r.state === "ok") return <span style={{ color: "#15803D", fontSize: 12.5 }}>✓</span>;
    if (r.state === "notrack") return <span style={{ color: C.muted, fontSize: 12.5 }}>не веде облік годин — розподіл за домовленістю</span>;
    if (r.state === "nosource") return <span style={{ color: C.muted, fontSize: 12.5 }}>годин ще немає</span>;
    if (r.state === "nodata") return <span style={{ color: C.warn, fontWeight: 600, fontSize: 12.5 }}>немає годин у трекері</span>;
    return <span style={{ color: C.warn, fontWeight: 600, fontSize: 12.5 }}>понад ±{r.tol} п.п.</span>;
  };
  const startDecide = (r) => {
    setOpenRow(r.employeeId + "|" + r.project);
    setForm(r.res ? { kind: r.res.action, comment: r.res.comment, hours: r.res.hours != null ? String(r.res.hours) : "" } : { kind: "plan", comment: "", hours: r.trackerHours != null ? String(r.trackerHours) : "" });
  };
  const saveDecision = async (r) => {
    const ok = await post("resolve", { employeeId: r.employeeId, project: r.project, kind: form.kind, comment: form.comment, hours: form.hours }, "Рішення збережено");
    if (ok) setOpenRow(null);
  };
  const chip = (k, label, n) => (
    <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k}
      style={{ cursor: "pointer", border: "1px solid " + (filter === k ? C.signal : C.line), background: filter === k ? C.signalSoft : C.surface, color: filter === k ? C.signal : C.ink2, borderRadius: 999, padding: "4px 12px", fontSize: 12.5, fontWeight: 600 }}>
      {label} · {n}
    </button>
  );

  // Хто ця людина: команда й посада, позначка «спільний», і куди ще розподілена (з PM відповідного проєкту).
  const person = (r) => (
    <div style={{ display: "grid", gap: 1 }}>
      <span><b>{r.name}</b>{r.shared && <span title="Працює на кількох проєктах (спільна команда або розробник з іншого проєкту)" style={{ marginLeft: 6, background: "#EEF2FF", color: "#4338CA", borderRadius: 999, padding: "1px 8px", fontSize: 11, fontWeight: 600 }}>спільний</span>}</span>
      {(r.team || r.position) && <span style={{ color: C.muted, fontSize: 12 }}>{[r.team, r.position].filter(Boolean).join(" · ")}</span>}
      {r.others.length > 0 && <span style={{ color: C.ink2, fontSize: 12 }}>Також: {r.others.map((o) => o.project + " " + num(o.pct) + "%" + (o.pm ? " (" + o.pm + ")" : "")).join(", ")}</span>}
    </div>
  );

  const decideForm = (r) => (
    <tr><td colSpan={6} style={{ background: "#F8FAFC" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12.5, color: C.muted }}>Що сталося
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={{ display: "block" }}>
            {Object.entries(d.actions).map(([a, l]) => <option key={a} value={a}>{l}</option>)}
          </select>
        </label>
        {form.kind === "manual" && (
          <label style={{ fontSize: 12.5, color: C.muted }}>Години
            <input type="number" min="0" max="744" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} style={{ display: "block", width: 100 }} />
          </label>
        )}
        <label style={{ fontSize: 12.5, color: C.muted, flex: "1 1 260px" }}>Коментар (обов'язково)
          <input type="text" value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} style={{ display: "block", width: "100%" }} placeholder={form.kind === "plan" ? "напр.: з 5-го числа працює на іншому проєкті, подам заявку" : form.kind === "tracker" ? "напр.: частину годин списали на інший проєкт" : "напр.: за моїми даними 60 год"} />
        </label>
        <button style={addBtn} disabled={busy} onClick={() => saveDecision(r)}>Зберегти</button>
        {r.res && <button className="link" disabled={busy} onClick={async () => { await post("resolve-clear", { employeeId: r.employeeId, project: r.project }); setOpenRow(null); }}>зняти рішення</button>}
        <button className="link" onClick={() => setOpenRow(null)}>скасувати</button>
      </div>
    </td></tr>
  );

  return (
    <>
      <section style={{ ...card, padding: 14, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>Звірка</h2>
          <select value={cur} onChange={(e) => { setOpenRow(null); setPeriod(e.target.value); }} aria-label="Період" style={{ width: "auto" }}>
            {choices.map((k) => <option key={k} value={k}>{label(k)}{k === d.defaultPeriod ? " (остання завершена)" : k > d.defaultPeriod ? " (триває)" : ""}</option>)}
          </select>
          <span style={{ fontSize: 12.5, color: d.hours ? C.muted : C.warn }}>
            {d.hours ? "Години: " + d.hours.count + " рядків, " + fmtDT(d.hours.at) : "Годин за період ще немає"}
          </span>
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {d.summary.length > 0 && <span style={{ fontSize: 13, fontWeight: 600, color: allConfirmed ? "#15803D" : C.ink2 }}>{allConfirmed ? "✓ " : ""}Підтверджено {confirmedCount} з {d.summary.length} проєктів</span>}
            {d.summary.length > 0 && !allConfirmed && (
              <button style={{ ...addBtn, opacity: canConfirm ? 1 : 0.45 }} disabled={busy || !canConfirm}
                onClick={() => { if (window.confirm("Підтверджую, що години по моїх проєктах за " + label(cur) + " перевірені й коректні.")) post("confirm", {}, "Звірку підтверджено"); }}>
                Підтвердити звірку
              </button>
            )}
          </span>
        </div>
        {hint && d.summary.length > 0 && <div style={{ color: C.muted, fontSize: 12.5 }}>{hint}</div>}
        {d.summary.length > 0 && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {chip("attn", "Потрібна увага", attnCount)}
            {chip("all", "Усі", d.rows.length)}
            {chip("shared", "Спільні працівники", sharedCount)}
            {openCount > 0 && <span style={{ color: C.warn, fontSize: 12.5, fontWeight: 600 }}>без рішення: {openCount}</span>}
          </div>
        )}
        <Info>
          Звіряємо, скільки людина реально працювала на проєкті (години з трекерів) з тим, що записано в Allocate (план у %). Факт у % — це години ÷ норма періоду (робочі дні × 8).
          Позначка «спільний» — людина працює на кількох проєктах (спільна команда або розробник з іншого проєкту); під ім'ям видно її команду, посаду і куди ще вона розподілена та хто там PM.
          Якщо відхилення більше за допуск, оберіть: «план застарів» (потрібне переведення), «трекер заповнено неточно» або свої години. Підтвердження зберігається по проєкту; якщо цифри потім зміняться, воно стане «застарілим».
        </Info>
        {isAdmin && (
          <div style={{ borderTop: "1px solid " + C.lineSoft, paddingTop: 8 }}>
            <button className="link" aria-expanded={showSettings} onClick={() => setShowSettings((v) => !v)}>⚙ Години, відповідність імен, допуск {showSettings ? "▴" : "▾"}</button>
            {showSettings && (
              <div style={{ display: "grid", gap: 12, marginTop: 10 }}>
                <label style={{ fontSize: 12.5, color: C.muted }}>Години за {label(cur)} — «Прізвище Ім'я; Проєкт; години», по рядку на людину й проєкт
                  <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Андрій Тест; Alpha; 64\nAndrii Test; Beta; 24"} style={{ width: "100%", marginTop: 4, fontFamily: "inherit" }} />
                </label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button className="ghost" disabled={busy || !text.trim()} onClick={async () => { const ok = await post("hours-set", { text }, "Години завантажено"); if (ok) setText(""); }}>Завантажити години</button>
                  {d.hours && <button className="link" style={{ color: C.stop }} disabled={busy} onClick={() => { if (window.confirm("Прибрати завантажені години за цей період? Підтвердження звірки лишаться, але покажуть застарілими.")) post("hours-clear", {}, "Години прибрано"); }}>прибрати завантажене</button>}
                </div>
                <div style={{ fontSize: 12.5, color: C.muted }}>Відповідність імен із трекерів (ClickUp, Redmine) тепер у <b>Довіднику → Трекери</b>: імпорт за email, ручна прив'язка. Підказки для невпізнаних імен — нижче.</div>
                {d.aliases && d.aliases.length > 0 && (
                  <details style={{ fontSize: 12.5, color: C.muted }}><summary style={{ cursor: "pointer" }}>Збережені відповідності</summary>
                    <div style={{ display: "grid", gap: 2, marginTop: 6 }}>
                      {d.aliases.map((a) => <div key={a.person}>{a.person} → <b>{a.name}</b> <button className="link" disabled={busy} onClick={() => post("alias-clear", { person: a.person })}>прибрати</button></div>)}
                    </div>
                  </details>
                )}
                {cfg && (
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", fontSize: 12.5, color: C.muted }}>
                    {[["tol", "Допуск, п.п."], ["tolSmall", "Для малих часток, п.п."], ["smallUpTo", "Мала частка — до, %"]].map(([k, l]) => (
                      <label key={k}>{l}<input type="number" min="0" max="100" value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} style={{ display: "block", width: 90 }} /></label>
                    ))}
                    <button className="ghost" disabled={busy} onClick={() => post("cfg-set", { tol: cfg.tol, tolSmall: cfg.tolSmall, smallUpTo: cfg.smallUpTo }, "Допуск збережено")}>Зберегти допуск</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {d.unmatched && d.unmatched.length > 0 && (
        <details style={{ ...card, padding: "10px 14px", borderColor: "#FED7AA" }} open={isAdmin}>
          <summary style={{ cursor: "pointer", color: C.warn, fontWeight: 600 }}>Години без відповідності в Allocate: {d.unmatched.length}</summary>
          <div style={{ color: C.muted, fontSize: 12.5, margin: "6px 0" }}>Людини немає в Allocate (інше написання імені, зовнішній виконавець) або проєкт з трекера не збігається з проєктом Allocate.</div>
          <div style={{ overflowX: "auto" }}><table>
            <thead><tr><th>Людина</th><th>Проєкт</th><th className="num">Години</th><th>Що не збіглося</th><th>Зіставити з людиною Allocate</th></tr></thead>
            <tbody>{d.unmatched.slice(0, 50).map((u, i) => <tr key={i}><td>{u.person}</td><td>{u.project}</td><td className="num">{num(u.hours)}</td><td>{u.why === "person" ? "людини немає в Allocate" : u.why === "project" ? "проєкту немає в Allocate" : "ні людини, ні проєкту"}</td>
              <td>{isAdmin && u.why !== "project" ? (
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  {u.suggest && <button className="ghost" disabled={busy} onClick={() => post("alias-set", { person: u.person, employeeId: u.suggest.employeeId }, "Відповідність збережено")}>Це {u.suggest.name}</button>}
                  <select defaultValue="" onChange={(e) => { if (e.target.value) post("alias-set", { person: u.person, employeeId: e.target.value }, "Відповідність збережено"); }} style={{ width: "auto", maxWidth: 220 }} aria-label={"Зіставити " + u.person}>
                    <option value="">{u.suggest ? "інша людина…" : "обрати людину…"}</option>
                    {(d.people || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                </span>) : <span style={{ color: C.muted, fontSize: 12.5 }}>{u.why === "project" ? "виправте назву проєкту в таблиці" : "лише адміністратор"}</span>}</td></tr>)}</tbody>
          </table></div>
          {d.unmatched.length > 50 && <div style={{ color: C.muted, fontSize: 12.5 }}>…і ще {d.unmatched.length - 50}</div>}
        </details>
      )}

      {!Object.keys(byProject).length && (
        <section style={{ ...card, padding: 20, color: C.muted }}>На ваших проєктах немає людей за цей період.</section>
      )}

      {Object.keys(byProject).map((project) => {
        const s = sumOf(project);
        const all = byProject[project];
        const rows = all.filter(pass);
        const st = s.state === "confirmed" ? ["✓ підтверджено · " + s.by + ", " + fmtDT(s.at), "#15803D", "#F0FDF4"]
          : s.state === "stale" ? ["підтвердження застаріло — цифри змінились", C.warn, C.warnSoft]
          : s.open ? ["потрібні рішення: " + s.open, C.warn, C.warnSoft] : ["готово до підтвердження", C.signal, C.signalSoft];
        const collapsed = !rows.length || (filter === "attn" && !expanded[project] && !rows.length);
        return (
          <section key={project} style={{ ...card, padding: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 14px", borderBottom: rows.length ? "1px solid " + C.lineSoft : "none" }}>
              <b style={{ fontSize: 15 }}>{project}</b>
              <span style={{ background: st[2], color: st[1], borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>{st[0]}</span>
              <span style={{ color: C.muted, fontSize: 12.5 }}>{all.length} {all.length === 1 ? "людина" : "людей"}{filter !== "all" && rows.length < all.length ? ", показано " + rows.length : ""}</span>
              <span style={{ marginLeft: "auto", display: "inline-flex", gap: 12 }}>
                {filter === "attn" && !rows.length && all.length > 0 && <button className="link" style={{ fontSize: 12.5 }} onClick={() => setFilter("all")}>показати всіх</button>}
                {s.state === "confirmed" && <button className="link" style={{ fontSize: 12.5 }} disabled={busy} onClick={() => post("reopen", { project }, "Підтвердження знято")}>зняти підтвердження</button>}
              </span>
            </div>
            {!collapsed && (
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead><tr><th>Людина</th><th className="num">План, %</th><th className="num">Факт</th><th className="num">Різниця</th><th>Стан / рішення</th><th></th></tr></thead>
                  <tbody>
                    {rows.map((r) => {
                      const k = r.employeeId + "|" + r.project;
                      const open = openRow === k;
                      const hot = needsDecision(r);
                      return (
                        <React.Fragment key={k}>
                          <tr style={hot ? { background: C.warnSoft } : undefined}>
                            <td>{person(r)}</td>
                            <td className="num" title={r.planSrc === "entry" ? "План із табеля команди за цей період" : "План за розподілом і переведеннями"}>{num(r.planPct)}{r.planSrc === "entry" && <span style={{ color: C.muted, fontSize: 11 }}> табель</span>}</td>
                            <td className="num">{r.factHours == null ? "—" : num(r.factHours) + " год · " + num(r.factPct) + "%"}{r.res && r.res.action === "manual" && r.trackerHours != null ? <div style={{ color: C.muted, fontSize: 11.5 }}>трекер {num(r.trackerHours)} год</div> : null}</td>
                            <td className="num" style={{ color: r.state === "warn" ? C.warn : undefined, fontWeight: r.state === "warn" ? 600 : 400 }}>{r.diff == null ? "—" : (r.diff > 0 ? "+" : "") + num(r.diff)}</td>
                            <td>{stateCell(r)}</td>
                            <td style={{ whiteSpace: "nowrap" }}>
                              {(r.state === "warn" || r.state === "nodata" || r.res) && !open && <button className="ghost" disabled={busy || !d.finished} onClick={() => startDecide(r)}>{r.res ? "Змінити" : "Рішення"}</button>}
                            </td>
                          </tr>
                          {open && decideForm(r)}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}

// Довідник → «Облік годин»: хто не веде облік годин у трекері (адмін-блок, People Partners, рекрутинг, окремі люди).
export function NoTrackBook({ token, C, card, setToast, onApiError }) {
  const [d, setD] = useState(null);
  const [cur, setCur] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (body) => {
    setBusy(true);
    try {
      const data = await reconCall(token, body ? "POST" : "GET", body || null, undefined);
      setD(data); setCur({ teams: data.noTrack.teams, employees: data.noTrack.employees, departments: data.noTrack.departments || [] });
      return data;
    } catch (e) { if (e.status === 401) onApiError && onApiError(e); else setToast(e.message); return null; }
    finally { setBusy(false); }
  }, [token]);
  useEffect(() => { load(); }, []);
  if (!d || !cur) return <section style={{ ...card, padding: 22, color: C.muted }}>Завантажуємо…</section>;
  const dirty = JSON.stringify([...cur.teams].sort()) !== JSON.stringify([...d.noTrack.teams].sort()) || JSON.stringify([...cur.employees].sort()) !== JSON.stringify([...d.noTrack.employees].sort()) || JSON.stringify([...cur.departments].sort()) !== JSON.stringify([...(d.noTrack.departments || [])].sort());
  const toggle = (k, id) => setCur({ ...cur, [k]: cur[k].includes(id) ? cur[k].filter((x) => x !== id) : [...cur[k], id] });
  const nameOf = (id) => ((d.people || []).find((p) => p.id === id) || {}).name || id;
  const chip = { border: "1px solid " + C.line, borderRadius: 999, padding: "3px 10px", fontSize: 13 };
  return (
    <section style={{ ...card, padding: 22, maxWidth: 720, display: "grid", gap: 14 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Облік годин</h2>
        <p style={{ margin: "6px 0 0", color: C.ink2, fontSize: 13.5 }}>Команди, відділи та люди, які не ведуть години в трекері (адмін-блок, People Partners, рекрутинг, customer care). У звірці PM для них немає позначки «немає годин у трекері» — розподіл збираєте ви вручну.</p>
      </div>
      <div>
        <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 6 }}>Команди</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {d.teamsList.map((t) => (
            <label key={t.id} style={{ ...chip, cursor: "pointer", background: cur.teams.includes(t.id) ? C.signalSoft : C.surface }}>
              <input type="checkbox" checked={cur.teams.includes(t.id)} onChange={() => toggle("teams", t.id)} style={{ marginRight: 6 }} />{t.name}
            </label>
          ))}
          {!d.teamsList.length && <span style={{ color: C.muted }}>Команд ще немає.</span>}
        </div>
      </div>
      {(d.departmentsList || []).length > 0 && (
        <div>
          <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 6 }}>Відділи й підрозділи (з PeopleForce)</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {d.departmentsList.map((n) => (
              <label key={n} style={{ ...chip, cursor: "pointer", background: cur.departments.includes(n) ? C.signalSoft : C.surface }}>
                <input type="checkbox" checked={cur.departments.includes(n)} onChange={() => toggle("departments", n)} style={{ marginRight: 6 }} />{n}
              </label>
            ))}
          </div>
        </div>
      )}
      <div>
        <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 6 }}>Окремі люди</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {cur.employees.map((id) => <span key={id} style={chip}>{nameOf(id)} <button onClick={() => toggle("employees", id)} aria-label={"Прибрати " + nameOf(id)} style={{ cursor: "pointer", background: "none", border: "none", color: C.signal }}>×</button></span>)}
          <select value="" onChange={(e) => { if (e.target.value && !cur.employees.includes(e.target.value)) setCur({ ...cur, employees: [...cur.employees, e.target.value] }); }} style={{ width: "auto", maxWidth: 240, border: "1px solid " + C.line, borderRadius: 8, padding: "6px 8px", background: "#fff" }} aria-label="Додати людину, яка не веде облік">
            <option value="">+ додати людину…</option>
            {(d.people || []).filter((p) => !cur.employees.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>
      <div>
        <button disabled={busy || !dirty} onClick={async () => { const r = await load({ action: "notrack-set", teams: cur.teams, employees: cur.employees, departments: cur.departments }); if (r) setToast("Збережено"); }}
          style={{ cursor: dirty ? "pointer" : "default", opacity: dirty ? 1 : 0.5, background: C.signal, color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontWeight: 600 }}>Зберегти</button>
      </div>
    </section>
  );
}
