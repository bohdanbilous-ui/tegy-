"use client";
// Довідник → «Трекери»: хто як записаний у ClickUp / Redmine (глобально, для звірки, дашборду годин і HR),
// плюс хто не веде облік годин узагалі.
import React, { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import Info from "./Info";
import { NoTrackBook } from "./ReconDesk";

async function call(token, method, body) {
  const res = await fetch("/api/identity", { method, cache: "no-store", headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || "HTTP " + res.status); e.status = res.status; throw e; }
  return data;
}

// Вивантаження користувачів: колонки «Task Name»/«Name», «Email», «Status». Рядки-заголовки груп (бізнес-юнітів) пропускаємо.
async function readUsersFile(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
  const hi = rows.findIndex((r) => r.some((c) => /email|e-mail|пошта/i.test(String(c))) && r.some((c) => /name|ім/i.test(String(c))));
  if (hi < 0) throw new Error("Не знайшов колонки з ім'ям та email.");
  const h = rows[hi].map((c) => String(c));
  const iN = h.findIndex((c) => /task name|^name|ім/i.test(c)), iE = h.findIndex((c) => /email|e-mail|пошта/i.test(c)), iS = h.findIndex((c) => /status|статус/i.test(c));
  return rows.slice(hi + 1).map((r) => ({ name: String(r[iN] || "").trim(), email: String(r[iE] || "").trim(), status: iS >= 0 ? String(r[iS] || "").trim() : "" })).filter((u) => u.name && /@/.test(u.email));
}

export default function TrackerBook({ token, C, card, setToast, onApiError }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sys, setSys] = useState("clickup");
  const [rep, setRep] = useState(null);
  const [q, setQ] = useState("");
  const [onlyFree, setOnlyFree] = useState(true);
  const [adding, setAdding] = useState(null); // { id, name, email }
  const fileRef = useRef(null);

  const run = useCallback(async (method, body, okText) => {
    setBusy(true);
    try {
      const data = await call(token, method, body);
      setD(data); if (data.report) setRep(data.report); if (okText) setToast(okText);
      return data;
    } catch (e) { if (e.status === 401) onApiError && onApiError(e); else setToast(e.message); return null; }
    finally { setBusy(false); }
  }, [token]);
  useEffect(() => { run("GET"); }, []);

  if (!d) return <section style={{ ...card, padding: 22, color: C.muted }}>Завантажуємо…</section>;
  const chip = { border: "1px solid " + C.line, borderRadius: 999, padding: "2px 10px", fontSize: 12.5, display: "inline-flex", gap: 6, alignItems: "center" };
  const ghost = { cursor: "pointer", background: C.surface, border: "1px solid " + C.line, borderRadius: 8, padding: "7px 12px", color: C.ink2, fontWeight: 500 };
  const inp = { border: "1px solid " + C.line, borderRadius: 8, padding: "6px 9px", background: "#fff", minHeight: 34 };
  const needle = q.trim().toLowerCase();
  const list = d.people.filter((p) => (!onlyFree || !p.accounts.length) && (!needle || (p.name + " " + p.email + " " + p.team + " " + p.accounts.map((a) => a.name + " " + a.email).join(" ")).toLowerCase().includes(needle)));
  const cov = d.coverage;
  const pct = cov.total ? Math.round((cov.linked / cov.total) * 100) : 0;
  const importFile = async (f) => {
    try { const rows = await readUsersFile(f); await run("POST", { action: "import", sys, rows }); } catch (e) { setToast(e.message); }
  };

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <section style={{ ...card, padding: 22, display: "grid", gap: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Трекери: хто як записаний</h2>
          <Info>
            У ClickUp і Redmine людей часто записано англійською чи за іншою поштою. Тут кожен співробітник Allocate отримує свої акаунти в трекерах.
            Ними користується звірка PM, а далі й дашборд годин та HR-метрики. Імпорт збігає людей за email із довідником (він приходить з PeopleForce), потім за повним ПІБ; схожі імена лише підказує.
          </Info>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <b>{cov.linked}</b> з <b>{cov.total}</b> співробітників мають акаунт у трекері ({pct}%)
          <div style={{ flex: "1 1 120px", maxWidth: 240, height: 6, borderRadius: 3, background: C.lineSoft }}><div style={{ width: pct + "%", height: 6, borderRadius: 3, background: C.signal }} /></div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={sys} onChange={(e) => setSys(e.target.value)} style={{ ...inp, width: "auto" }} aria-label="Трекер">{Object.entries(d.systems).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} aria-label="Вивантаження користувачів трекера" onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) importFile(f); }} />
          <button style={ghost} disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}>Імпорт користувачів (xlsx / csv)</button>
          <span style={{ fontSize: 12.5, color: C.muted }}>Вивантаження зі списку користувачів: ім'я, email, статус.</span>
        </div>
        {rep && (
          <div style={{ display: "grid", gap: 6, fontSize: 12.5, color: C.ink2, border: "1px solid " + C.line, borderRadius: 8, padding: 10 }}>
            <div><b>{rep.total}</b> у файлі: за email — <b>{rep.byEmail}</b>, за ПІБ — <b>{rep.byName}</b>; нових прив'язок <b>{rep.saved}</b>; підказок <b>{rep.suggested.length}</b>; не знайдено <b>{rep.none.length}</b>. <button style={{ ...ghost, border: "none", padding: 0, color: C.signal, background: "none" }} onClick={() => setRep(null)}>закрити</button></div>
            {rep.suggested.map((u) => (
              <div key={u.person} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span>{u.person}{u.email ? " · " + u.email : ""}</span>
                <button style={ghost} disabled={busy} onClick={async () => { const r = await run("POST", { action: "link", sys: rep.sys, person: u.person, email: u.email, employeeId: u.suggest.employeeId }, "Прив'язано"); if (r) setRep((x) => x && { ...x, suggested: x.suggested.filter((s) => s.person !== u.person) }); }}>Це {u.suggest.name}</button>
              </div>
            ))}
            {rep.none.length > 0 && (
              <details><summary style={{ cursor: "pointer" }}>Немає в Allocate ({rep.none.length})</summary>
                <div style={{ display: "grid", gap: 2, marginTop: 4, color: C.muted }}>{rep.none.map((u) => <div key={u.person}>{u.person}{u.email ? " · " + u.email : ""}{u.status && u.status !== "ACTIVE" ? " · " + u.status : ""}</div>)}</div>
              </details>
            )}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Пошук: ім'я, email, команда" style={{ ...inp, minWidth: 240 }} aria-label="Пошук співробітника" />
          <label style={{ fontSize: 12.5, color: C.ink2 }}><input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} style={{ marginRight: 6 }} />Лише без акаунта ({cov.total - cov.linked})</label>
        </div>
        <div style={{ display: "grid", gap: 0, border: "1px solid " + C.line, borderRadius: 8, overflow: "hidden" }}>
          {list.slice(0, 80).map((p, i) => (
            <div key={p.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,2fr)", gap: 12, padding: "8px 12px", borderTop: i ? "1px solid " + C.lineSoft : "none", alignItems: "start" }}>
              <div><div style={{ fontWeight: 600 }}>{p.name}</div><div style={{ fontSize: 12, color: C.muted }}>{p.team || "без команди"}{p.email ? " · " + p.email : " · немає email"}</div></div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {p.accounts.map((a) => (
                  <span key={a.sys + a.name + a.email} style={chip} title={a.email}>
                    <span style={{ color: C.muted }}>{d.systems[a.sys]}</span> {a.name || a.email}
                    <button aria-label={"Відв'язати " + (a.name || a.email)} disabled={busy} onClick={() => run("POST", { action: "unlink", employeeId: p.id, sys: a.sys, person: a.name, email: a.email })} style={{ cursor: "pointer", background: "none", border: "none", color: C.signal }}>×</button>
                  </span>
                ))}
                {adding && adding.id === p.id ? (
                  <>
                    <input type="text" autoFocus value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="Ім'я в трекері" style={{ ...inp, width: 170 }} aria-label="Ім'я в трекері" />
                    <button style={ghost} disabled={busy || !adding.name.trim()} onClick={async () => { const r = await run("POST", { action: "link", sys, person: adding.name, employeeId: p.id }, "Прив'язано"); if (r) setAdding(null); }}>Додати ({d.systems[sys]})</button>
                    <button style={{ ...ghost, border: "none" }} onClick={() => setAdding(null)}>скасувати</button>
                  </>
                ) : <button style={{ ...ghost, padding: "2px 10px", fontSize: 12.5 }} onClick={() => setAdding({ id: p.id, name: "" })}>+ акаунт</button>}
              </div>
            </div>
          ))}
          {!list.length && <div style={{ padding: 14, color: C.muted }}>{onlyFree && !needle ? "Усі співробітники мають акаунт у трекері." : "Нікого не знайдено."}</div>}
        </div>
        {list.length > 80 && <div style={{ fontSize: 12.5, color: C.muted }}>Показано 80 з {list.length}. Уточніть пошук.</div>}
      </section>
      <NoTrackBook token={token} C={C} card={card} setToast={setToast} onApiError={onApiError} />
    </div>
  );
}
