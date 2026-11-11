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
  const [showAdmin, setShowAdmin] = useState(false);
  const [cfg, setCfg] = useState(null);

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
  const byProject = {};
  d.rows.forEach((r) => { (byProject[r.project] = byProject[r.project] || []).push(r); });
  const sumOf = (p) => d.summary.find((s) => s.project === p);
  const needsDecision = (r) => (r.state === "warn" || r.state === "nodata") && !r.res;
  const anyOpen = d.rows.some(needsDecision);
  const allConfirmed = d.summary.length > 0 && d.summary.every((s) => s.state === "confirmed");
  const canConfirm = d.finished && d.hours && d.summary.length > 0 && !anyOpen && !allConfirmed;

  const stateCell = (r) => {
    if (r.res) {
      const A = d.actions[r.res.action] || r.res.action;
      return <span style={{ color: C.ink2, fontSize: 12.5 }}><b>{A}</b>{r.res.action === "manual" ? " · " + num(r.res.hours) + " год" : ""} · «{r.res.comment}»</span>;
    }
    if (r.state === "ok") return <span style={{ color: "#15803D", fontSize: 12.5 }}>✓ у межах допуску</span>;
    if (r.state === "nosource") return <span style={{ color: C.muted, fontSize: 12.5 }}>годин ще немає</span>;
    if (r.state === "nodata") return <span style={{ color: C.warn, fontWeight: 600, fontSize: 12.5 }}>немає годин у трекері</span>;
    return <span style={{ color: C.warn, fontWeight: 600, fontSize: 12.5 }}>відхилення понад ±{r.tol} п.п.</span>;
  };

  const startDecide = (r) => {
    setOpenRow(r.employeeId + "|" + r.project);
    setForm(r.res ? { kind: r.res.action, comment: r.res.comment, hours: r.res.hours != null ? String(r.res.hours) : "" } : { kind: "plan", comment: "", hours: r.trackerHours != null ? String(r.trackerHours) : "" });
  };
  const saveDecision = async (r) => {
    const ok = await post("resolve", { employeeId: r.employeeId, project: r.project, kind: form.kind, comment: form.comment, hours: form.hours }, "Рішення збережено");
    if (ok) setOpenRow(null);
  };

  return (
    <>
      <section style={{ ...card, padding: 16, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>Звірка годин із планом</h2>
          <select value={cur} onChange={(e) => { setOpenRow(null); setPeriod(e.target.value); }} aria-label="Період" style={{ width: "auto" }}>
            {choices.map((k) => <option key={k} value={k}>{label(k)}{k === d.defaultPeriod ? " (остання завершена)" : k > d.defaultPeriod ? " (триває)" : ""}</option>)}
          </select>
          <span style={{ marginLeft: "auto", fontSize: 12.5, color: d.hours ? "#15803D" : C.warn, fontWeight: 600 }}>
            {d.hours ? "Години завантажено: " + d.hours.count + " рядків · " + d.hours.by + ", " + fmtDT(d.hours.at) : "Годин за цей період ще немає"}
          </span>
        </div>
        <Info>
          Тут ви звіряєте, скільки людина реально працювала на вашому проєкті (години з трекерів) з тим, що записано в Allocate (план у %).
          Факт у % — це години ÷ норма періоду (робочі дні × 8). Якщо різниця більша за допуск, оберіть, що сталося: «план застарів» (потрібне переведення), «трекер заповнено неточно» або вкажіть свої години.
          Коли по всіх відхиленнях є рішення, підтвердіть звірку: бухгалтер побачить, що ваші проєкти перевірені. Якщо після підтвердження цифри зміняться, звірка стане «застарілою» й потребуватиме повторного підтвердження.
        </Info>
        {isAdmin && (
          <div style={{ borderTop: "1px solid " + C.lineSoft, paddingTop: 10 }}>
            <button className="link" aria-expanded={showAdmin} onClick={() => setShowAdmin((v) => !v)}>Адміністратор: завантажити години й допуск {showAdmin ? "▴" : "▾"}</button>
            {showAdmin && (
              <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                <label style={{ fontSize: 12.5, color: C.muted }}>Години за {label(cur)} — по рядку на людину й проєкт: «Прізвище Ім'я; Проєкт; години»
                  <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Андрій Тест; Alpha; 64\nАндрій Тест; Beta; 24"} style={{ width: "100%", marginTop: 4, fontFamily: "inherit" }} />
                </label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button className="ghost" disabled={busy || !text.trim()} onClick={async () => { const ok = await post("hours-set", { text }, "Години завантажено"); if (ok) setText(""); }}>Завантажити</button>
                  {d.hours && <button className="link" style={{ color: C.stop }} disabled={busy} onClick={() => { if (window.confirm("Прибрати завантажені години за цей період? Підтвердження звірки лишаться, але покажуть застарілими.")) post("hours-clear", {}, "Години прибрано"); }}>прибрати завантажене</button>}
                </div>
                {cfg && (
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", fontSize: 12.5, color: C.muted }}>
                    {[["tol", "Допуск, п.п."], ["tolSmall", "Допуск для малих часток, п.п."], ["smallUpTo", "Мала частка — до, %"]].map(([k, l]) => (
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
        <section style={{ ...card, padding: 16, display: "grid", gap: 8, borderColor: "#FED7AA" }}>
          <b style={{ color: C.warn }}>Години, які не вдалося віднести до жодного PM: {d.unmatched.length}</b>
          <span style={{ color: C.muted, fontSize: 12.5 }}>Людини немає в Allocate (інше написання імені, зовнішній виконавець) або проєкт із трекера не збігається з проєктом Allocate. Виправте назву в таблиці годин і завантажте її знову.</span>
          <div style={{ overflowX: "auto" }}><table>
            <thead><tr><th>Людина</th><th>Проєкт</th><th className="num">Години</th><th>Що не збіглося</th></tr></thead>
            <tbody>{d.unmatched.slice(0, 50).map((u, i) => <tr key={i}><td>{u.person}</td><td>{u.project}</td><td className="num">{num(u.hours)}</td><td>{u.why === "person" ? "людини немає в Allocate" : u.why === "project" ? "проєкту немає в Allocate" : "ні людини, ні проєкту"}</td></tr>)}</tbody>
          </table></div>
          {d.unmatched.length > 50 && <span style={{ color: C.muted, fontSize: 12.5 }}>…і ще {d.unmatched.length - 50}</span>}
        </section>
      )}

      {!Object.keys(byProject).length && (
        <section style={{ ...card, padding: 20, color: C.muted }}>На ваших проєктах немає людей за цей період.</section>
      )}

      {Object.keys(byProject).map((project) => {
        const s = sumOf(project) || {};
        const rows = byProject[project];
        const st = s.state === "confirmed" ? ["✓ підтверджено · " + s.by + ", " + fmtDT(s.at), "#15803D", "#F0FDF4"]
          : s.state === "stale" ? ["підтвердження застаріло — цифри змінились", C.warn, C.warnSoft]
          : s.open ? ["потрібні рішення: " + s.open, C.warn, C.warnSoft] : ["готово до підтвердження", C.signal, C.signalSoft];
        return (
          <section key={project} style={{ ...card, padding: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "12px 16px", borderBottom: "1px solid " + C.lineSoft }}>
              <b style={{ fontSize: 15 }}>{project}</b>
              <span style={{ background: st[2], color: st[1], borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>{st[0]}</span>
              {s.state === "confirmed" && <button className="link" style={{ marginLeft: "auto", fontSize: 12.5 }} disabled={busy} onClick={() => post("reopen", { project }, "Підтвердження знято")}>зняти підтвердження</button>}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead><tr><th>Людина</th><th className="num">План, %</th><th className="num">Факт, год</th><th className="num">Факт, %</th><th className="num">Різниця</th><th>Стан / рішення</th><th></th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const k = r.employeeId + "|" + r.project;
                    const open = openRow === k;
                    const hot = needsDecision(r);
                    return (
                      <React.Fragment key={k}>
                        <tr style={hot ? { background: C.warnSoft } : undefined}>
                          <td><b>{r.name}</b></td>
                          <td className="num" title={r.planSrc === "entry" ? "План із табеля команди за цей період" : "План за розподілом і переведеннями"}>{num(r.planPct)}{r.planSrc === "entry" && <span style={{ color: C.muted, fontSize: 11 }}> табель</span>}</td>
                          <td className="num">{num(r.factHours)}{r.res && r.res.action === "manual" && r.trackerHours != null ? <span style={{ color: C.muted }}> (трекер {num(r.trackerHours)})</span> : null}</td>
                          <td className="num">{num(r.factPct)}</td>
                          <td className="num" style={{ color: r.state === "warn" ? C.warn : undefined, fontWeight: r.state === "warn" ? 600 : 400 }}>{r.diff == null ? "—" : (r.diff > 0 ? "+" : "") + num(r.diff)}</td>
                          <td>{stateCell(r)}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            {(r.state === "warn" || r.state === "nodata" || r.res) && !open && <button className="ghost" disabled={busy || !d.finished} onClick={() => startDecide(r)}>{r.res ? "Змінити" : "Рішення"}</button>}
                          </td>
                        </tr>
                        {open && (
                          <tr><td colSpan={7} style={{ background: "#F8FAFC" }}>
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
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {d.summary.length > 0 && (
        <section style={{ ...card, padding: "14px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {allConfirmed ? <b style={{ color: "#15803D" }}>✓ Звірку за цей період підтверджено по всіх ваших проєктах</b> : (
            <>
              <button style={{ ...addBtn, opacity: canConfirm ? 1 : 0.45 }} disabled={busy || !canConfirm}
                onClick={() => { if (window.confirm("Підтверджую, що години по моїх проєктах за " + label(cur) + " перевірені й коректні.")) post("confirm", {}, "Звірку підтверджено"); }}>
                Підтверджую звірку
              </button>
              <span style={{ color: C.muted, fontSize: 12.5 }}>
                {!d.finished ? "Період ще триває — підтвердити можна після його завершення."
                  : !d.hours ? "Спершу потрібні години за період (їх завантажує адміністратор)."
                  : anyOpen ? "Є відхилення без рішення — оберіть дію по кожному." : "Усе перевірено — можна підтверджувати."}
              </span>
            </>
          )}
        </section>
      )}
    </>
  );
}
