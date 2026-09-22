"use client";
import React, { useState, useEffect, useRef } from "react";

/* Нагадування відповідальним про табель (лише адміністратор).
   Текст і Slack ID зберігаються на сервері; «Надіслати» ставить повідомлення в чергу,
   а заплановане завдання розсилає їх у Slack від імені адміністратора протягом години. */

const C = {
  surface: "#FFFFFF", ink: "#141E38", ink2: "#37456A", muted: "#6F7B99", line: "#C2CDE1", lineSoft: "#DFE5F0",
  signal: "#0C7480", signalSoft: "#DBEFF0", warn: "#8A5510", warnSoft: "#F8EBD6", stop: "#8A2E44", stopSoft: "#F6E2E7",
};
const SERIF = '"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif';
const card = { background: C.surface, border: "1px solid " + C.line, borderRadius: 4 };
const addBtn = { cursor: "pointer", background: C.ink, color: "#fff", border: "none", borderRadius: 3, padding: "9px 16px", whiteSpace: "nowrap" };
const pad = (n) => String(n).padStart(2, "0");
const fmtDT = (s) => { const d = new Date(s); return isNaN(d) ? "—" : pad(d.getDate()) + "." + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const VARS = ["{ім'я}", "{команда}", "{період}", "{заповнено}", "{бракує}", "{посилання}"];

export default function Reminders({ getToken, onToast }) {
  const [d, setD] = useState(null);
  const [period, setPeriod] = useState("");
  const [text, setText] = useState("");
  const [slack, setSlack] = useState({});
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const dirty = useRef(false);

  async function call(method, body, q) {
    const res = await fetch("/api/reminders" + (q || ""), {
      method, cache: "no-store",
      headers: { Authorization: "Bearer " + getToken(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }
  function adopt(x, keepText) {
    setD((old) => ({ ...(old || {}), ...x }));
    if (!keepText) { setText(x.template); setSlack(x.slack || {}); dirty.current = false; }
    setPick(Object.fromEntries((x.targets || []).map((t) => [t.name, !!t.slackId])));
  }
  async function load(p) {
    try { setErr(""); adopt(await call("GET", null, p ? "?period=" + p : ""), dirty.current); }
    catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(period); }, [period]);

  async function save() {
    setBusy(true);
    try { adopt(await call("PUT", { template: text, slack, periodKey: d.periodKey })); onToast("Текст нагадування збережено."); }
    catch (e) { onToast("Не збережено: " + e.message); }
    finally { setBusy(false); }
  }
  async function toggleAuto() {
    try { adopt(await call("PUT", { auto: !d.auto, periodKey: d.periodKey }), true); } catch (e) { onToast(e.message); }
  }
  async function send() {
    const names = (d.targets || []).filter((t) => pick[t.name] && t.slackId).map((t) => t.name);
    if (!names.length) return onToast("Нікого не вибрано.");
    if (dirty.current) return onToast("Спершу збережіть змінений текст — надсилається збережений.");
    if (!window.confirm("Надіслати нагадування за «" + d.periodLabel + "» " + names.length + " відповідальним?\n\n" + names.join("\n"))) return;
    setBusy(true);
    try { adopt(await call("POST", { periodKey: d.periodKey, names }), true); onToast("Поставлено в чергу: повідомлення підуть у Slack протягом години."); }
    catch (e) { onToast("Не надіслано: " + e.message); }
    finally { setBusy(false); }
  }

  if (err) return <section style={{ ...card, padding: 20 }}><p role="alert" style={{ margin: 0, color: C.stop }}>Нагадування: {err}</p></section>;
  if (!d) return <section style={{ ...card, padding: 20, color: C.muted }}>Завантаження…</section>;

  const targets = d.targets || [];
  const owners = [...new Set([...(d.status || []).map((r) => r.owner).filter(Boolean), ...Object.keys(slack)])];
  const preview = targets[0] ? targets[0].text : "";
  const changed = text !== d.template;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {!d.keyReady && (
        <p role="alert" style={{ margin: 0, background: C.warnSoft, border: "1px solid #E6CFA6", borderRadius: 3, padding: "12px 14px", color: C.warn }}>
          Не налаштовано ключ REMINDER_SECRET у Vercel — без нього черга не розсилається. Автонагадування тим часом надсилає старий текст.
        </p>
      )}
      <section style={{ ...card, padding: 20 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 20, fontWeight: 600 }}>Нагадування</h2>
          <select value={d.periodKey} onChange={(e) => setPeriod(e.target.value)} aria-label="Період" style={{ width: "auto", padding: "7px 9px" }}>
            {[d.current, d.previous].filter(Boolean).map((k) => <option key={k} value={k}>{k === d.current ? "поточний період" : "попередній період"}</option>)}
          </select>
          <span style={{ color: C.ink2 }}>{d.periodLabel}</span>
          <label style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={d.auto} onChange={toggleAuto} style={{ width: "auto" }} />
            автоматично 14-го і в передостанній день місяця о 10:00
          </label>
        </div>

        <div style={{ overflowX: "auto", marginTop: 14 }}>
          <table>
            <thead><tr><th style={{ width: 44 }} /><th>Команда</th><th>Відповідальний</th><th style={{ width: 120 }}>Заповнено</th><th style={{ width: 150 }}>Подано</th><th style={{ width: 170 }}>Slack ID</th></tr></thead>
            <tbody>
              {(d.status || []).map((r) => {
                const t = targets.find((x) => x.name === r.owner);
                return (
                  <tr key={r.teamId} style={r.submitted ? { color: C.muted } : undefined}>
                    <td>{t && <input type="checkbox" checked={!!pick[t.name]} disabled={!t.slackId} onChange={(e) => setPick((p) => ({ ...p, [t.name]: e.target.checked }))} style={{ width: "auto" }} aria-label={"Надіслати " + r.owner} />}</td>
                    <td>{r.team}</td>
                    <td>{r.owner || <span style={{ color: C.warn }}>не призначено</span>}</td>
                    <td className="num" style={{ color: r.filled === r.people ? C.signal : C.warn }} title={r.missing.join(", ")}>{r.filled} з {r.people}</td>
                    <td>{r.submitted ? <span style={{ color: C.signal }}>так, {fmtDT(r.submitted.at)}</span> : "ні"}</td>
                    <td>
                      {r.owner && (
                        <input type="text" value={slack[r.owner] || ""} placeholder="U0123ABCD" aria-label={"Slack ID " + r.owner}
                          onChange={(e) => { dirty.current = true; setSlack((s) => ({ ...s, [r.owner]: e.target.value.trim() })); }} style={{ padding: "6px 8px" }} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ margin: "8px 0 0", color: C.muted, fontSize: 12.5 }}>
          Надсилаємо лише тим, чия команда ще не подала період. Slack ID — у профілі людини в Slack: «⋯» → «Копіювати ID учасника».
          {owners.some((o) => !slack[o]) ? " Без Slack ID людині не надішлемо." : ""}
        </p>
      </section>

      <section style={{ ...card, padding: 20 }}>
        <h3 style={{ margin: 0, fontFamily: SERIF, fontSize: 17, fontWeight: 600 }}>Текст повідомлення</h3>
        <p style={{ margin: "4px 0 10px", color: C.muted, fontSize: 12.5 }}>
          Підстановки: {VARS.map((v) => (
            <button key={v} className="link" style={{ marginRight: 8, fontSize: 12.5 }} onClick={() => { dirty.current = true; setText((t) => t + v); }}>{v}</button>
          ))}
        </p>
        <textarea value={text} onChange={(e) => { dirty.current = true; setText(e.target.value); }} rows={11} aria-label="Текст нагадування"
          style={{ width: "100%", boxSizing: "border-box", font: "inherit", padding: "10px 12px", border: "1px solid " + C.line, borderRadius: 3, resize: "vertical" }} />
        <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button style={{ ...addBtn, opacity: changed || dirty.current ? 1 : 0.5 }} disabled={busy} onClick={save}>Зберегти</button>
          <button className="ghost" onClick={() => { dirty.current = true; setText(d.defaultTemplate); }}>Текст за замовчуванням</button>
          {d.updatedAt && <span style={{ color: C.muted, fontSize: 12.5 }}>Збережено {fmtDT(d.updatedAt)}, {d.updatedBy}</span>}
        </div>
        {preview && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 6 }}>Так побачить {targets[0].name} (за збереженим текстом)</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", font: "inherit", fontSize: 13.5, background: "#F4F7FC", border: "1px solid " + C.lineSoft, borderRadius: 3, padding: "12px 14px" }}>{preview}</pre>
          </div>
        )}
      </section>

      <section style={{ ...card, padding: 20 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button style={addBtn} disabled={busy || !targets.some((t) => pick[t.name])} onClick={send}>
            Надіслати {targets.filter((t) => pick[t.name]).length || ""} {targets.filter((t) => pick[t.name]).length ? "відповідальним" : ""}
          </button>
          <span style={{ color: C.muted, fontSize: 12.5 }}>
            {targets.length ? "Повідомлення підуть у Slack від вашого імені протягом години." : "Усі команди подали цей період — надсилати нікому."}
          </span>
        </div>
        {(d.jobs || []).length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 6 }}>Історія</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: C.ink2 }}>
              {d.jobs.map((j) => (
                <li key={j.id} style={{ marginBottom: 4 }}>
                  {fmtDT(j.at)} · {j.auto ? "автоматично" : j.by} · {j.targets.length} {j.targets.length === 1 ? "людина" : "людей"} ·{" "}
                  {j.status === "sent"
                    ? <span style={{ color: (j.results || []).some((r) => !r.ok) ? C.warn : C.signal }}>
                        надіслано {fmtDT(j.sentAt)}{(j.results || []).filter((r) => !r.ok).length ? " (не вдалося: " + j.results.filter((r) => !r.ok).map((r) => r.name).join(", ") + ")" : ""}
                      </span>
                    : <span style={{ color: C.warn }}>{j.status === "claimed" ? "надсилається" : "у черзі"}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
