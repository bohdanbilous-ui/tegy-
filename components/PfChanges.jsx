"use client";
/* Зміни посади (ролі) й підрозділу (БЮ) з PeopleForce, що чекають на рішення адміністратора.
   Підтвердження: з дати зміни створюється переведення на новий розподіл — із нього фін. облік
   і відомості ЗП рахують новий тег (період ділиться по днях). Картка людини оновлюється. */
import React, { useState, useMemo } from "react";
import { allocAt, asAlloc, sameAlloc, tagOf, allocText } from "../lib/alloc";

const C = {
  surface: "#FFFFFF", ink: "#0F172A", ink2: "#334155", muted: "#64748B", line: "#DDE3EC", lineSoft: "#EEF2F6",
  signal: "#2563EB", signalSoft: "#EFF6FF", warn: "#B45309", warnSoft: "#FFF7ED", stop: "#B91C1C", stopSoft: "#FEF2F2",
};
const fmt = (s) => (s ? s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4) : "—");
const FIELD = { position: "Посада", division: "БЮ" };
const STATUS = { confirmed: ["підтверджено", C.signal, C.signalSoft], dismissed: ["відхилено", C.stop, C.stopSoft], auto: ["повернули в PeopleForce", C.muted, "#E6EAF2"] };

function Card({ item, emp, transfers, teams, projects, codes, buMap, busy, onDecide }) {
  const [date, setDate] = useState(item.detectedAt || "");
  const cur = useMemo(() => (emp && /^\d{4}-\d{2}-\d{2}$/.test(date) ? allocAt(emp, transfers, date) : []), [emp, transfers, date]);
  const guess = item.fields.includes("division") && buMap[item.to.division] ? [{ project: buMap[item.to.division], percent: 100 }] : null;
  const [rows, setRows] = useState(null); // null — ще не правили: показуємо підказку або поточний
  const shown = rows || guess || cur.map((r) => ({ ...r }));
  const [applyPos, setApplyPos] = useState(true);
  const [applyDiv, setApplyDiv] = useState(true);
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const clean = shown.filter((r) => r.project && Number(r.percent) > 0).map((r) => ({ project: r.project, percent: Number(r.percent) }));
  const total = clean.reduce((s, r) => s + r.percent, 0);
  const changed = clean.length > 0 && !sameAlloc(clean, cur);
  const team = emp && teams.find((t) => t.id === emp.teamId);
  const edit = (i, patch) => setRows(shown.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(date) && (!changed || Math.abs(total - 100) < 0.01);

  return (
    <div style={{ border: "1px solid " + C.line, borderRadius: 10, padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <b style={{ fontSize: 15 }}>{item.name}</b>
        <span style={{ color: C.muted, fontSize: 12.5 }}>помічено {fmt(item.detectedAt)}</span>
        {!emp && <span style={{ color: C.stop, fontSize: 12.5 }}>людини вже немає в довіднику</span>}
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {item.fields.map((k) => (
          <div key={k} style={{ fontSize: 13.5 }}>
            <span style={{ color: C.muted, display: "inline-block", minWidth: 70 }}>{FIELD[k]}</span>
            <span style={{ textDecoration: "line-through", color: C.muted }}>{item.from[k] || "—"}</span>
            {" → "}<b>{item.to[k] || "—"}</b>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "grid", gap: 4, fontSize: 12, color: C.muted, fontWeight: 600 }}>
          Діє з
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ padding: "6px 8px" }} />
        </label>
        <div style={{ fontSize: 12.5, color: C.ink2 }}>
          Зараз на цю дату: <b>{allocText(cur)}</b> · тег <span className="num">{tagOf(cur, codes) || "—"}</span>
        </div>
      </div>

      <div>
        <div style={{ fontSize: 12, color: C.muted, fontWeight: 600, marginBottom: 6 }}>
          Розподіл після зміни {guess && !rows && <span style={{ fontWeight: 400 }}>· підказка з попередніх рішень для БЮ «{item.to.division}»</span>}
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          {shown.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select value={r.project} onChange={(e) => edit(i, { project: e.target.value })} aria-label="Проєкт" style={{ minWidth: 220, width: "auto", maxWidth: 360 }}>
                <option value="">— проєкт —</option>
                {[...new Set([...projects, r.project].filter(Boolean))].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <input type="number" min="0" max="100" value={r.percent} onChange={(e) => edit(i, { percent: e.target.value })} aria-label="Відсоток" style={{ width: 80, minWidth: 0 }} />
              <span style={{ color: C.muted }}>%</span>
              {shown.length > 1 && <button className="link" onClick={() => setRows(shown.filter((_, j) => j !== i))}>прибрати</button>}
            </div>
          ))}
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <button className="link" onClick={() => setRows([...shown, { project: "", percent: 0 }])}>+ проєкт</button>
            <button className="link" onClick={() => setRows(cur.map((r) => ({ ...r })))}>лишити як є</button>
            <span className="num" style={{ fontSize: 12.5, color: Math.abs(total - 100) < 0.01 ? C.muted : C.stop }}>разом {Math.round(total * 100) / 100}%</span>
          </div>
        </div>
      </div>

      <div style={{ background: changed ? C.signalSoft : "#F8FAFC", borderRadius: 8, padding: "10px 12px", fontSize: 13 }}>
        {changed ? (
          <>Буде створено переведення з {fmt(date)}: <b>{allocText(cur)}</b> → <b>{allocText(clean)}</b>.
            Новий тег: <span className="num" style={{ textDecoration: "line-through", color: C.muted }}>{tagOf(cur, codes) || "—"}</span>{" → "}
            <b className="num">{tagOf(clean, codes) || "—"}</b>
            {clean.some((r) => !codes[r.project]) && <span style={{ color: C.warn }}> · у проєкту немає коду для тегів</span>}</>
        ) : <>Розподіл не змінюється — переведення не буде, тег лишається <b className="num">{tagOf(cur, codes) || "—"}</b>. Оновиться лише картка людини.</>}
        {team && changed && (
          <div style={{ color: C.warn, marginTop: 6 }}>
            Людина в табелі команди «{team.name}». За періоди, де табель уже заповнено, тег береться з табеля — попросіть {team.owner || "відповідального"} внести новий розподіл з {fmt(date)}.
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
        {item.fields.includes("position") && <label><input type="checkbox" checked={applyPos} onChange={(e) => setApplyPos(e.target.checked)} /> оновити посаду в картці</label>}
        {item.fields.includes("division") && <label><input type="checkbox" checked={applyDiv} onChange={(e) => setApplyDiv(e.target.checked)} /> оновити БЮ в картці</label>}
      </div>
      {changed && (
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={"Підстава (за замовчуванням «Зміна " + (item.fields.includes("division") ? "БЮ" : "посади") + " в PeopleForce»)"} />
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button disabled={!emp || !ok || busy} onClick={() => onDecide("confirm", { id: item.id, effectiveDate: date, alloc: changed ? clean : null, reason, applyPosition: applyPos, applyDivision: applyDiv })}
          style={{ cursor: "pointer", background: C.signal, color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontWeight: 600, opacity: !emp || !ok || busy ? 0.5 : 1 }}>
          {changed ? "Підтвердити й сформувати тег" : "Підтвердити"}
        </button>
        <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="коментар до відхилення" style={{ maxWidth: 260 }} />
        <button className="ghost" disabled={busy} onClick={() => onDecide("dismiss", { id: item.id, comment })}>Відхилити</button>
      </div>
    </div>
  );
}

export default function PfChanges({ changes, buMap, employees, transfers, teams, projects, codes, onDecide }) {
  const [busy, setBusy] = useState(false);
  const open = (changes || []).filter((x) => x.status === "new");
  const done = (changes || []).filter((x) => x.status !== "new").sort((a, b) => String(b.decidedAt || "").localeCompare(String(a.decidedAt || ""))).slice(0, 40);
  const decide = async (action, body) => { setBusy(true); try { await onDecide(action, body); } finally { setBusy(false); } };
  const tr = useMemo(() => (transfers || []).map((t) => ({ ...t, from: asAlloc(t.from), to: asAlloc(t.to) })), [transfers]);

  return (
    <section style={{ background: C.surface, border: "1px solid " + C.line, borderRadius: 10, padding: 20, display: "grid", gap: 14 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Зміни посади й БЮ з PeopleForce {open.length > 0 && <span style={{ color: C.warn }}>· {open.length}</span>}</h2>
        <p style={{ margin: "4px 0 0", color: C.muted, fontSize: 12.5 }}>
          Синхронізація фіксує, якщо в PeopleForce змінилась посада людини чи її БЮ (підрозділ). Сама картка не змінюється, доки ви не підтвердите.
          Після підтвердження з дати зміни створюється переведення на новий розподіл, і з нього фін. облік і відомості ЗП рахують новий тег (період ділиться по днях).
        </p>
      </div>
      {open.length === 0 && <p style={{ margin: 0, color: C.muted }}>Нових змін немає.</p>}
      {open.map((x) => (
        <Card key={x.id} item={x} emp={employees.find((e) => e.id === x.employeeId)} transfers={tr} teams={teams}
          projects={projects} codes={codes} buMap={buMap || {}} busy={busy} onDecide={decide} />
      ))}
      {done.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", color: C.ink2, fontSize: 13 }}>Оброблені: {done.length}</summary>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Людина</th><th>Зміна</th><th>Рішення</th><th>Тег</th></tr></thead>
            <tbody>
              {done.map((x) => {
                const [l, fg, bg] = STATUS[x.status] || [x.status, C.muted, "#eee"];
                return (
                  <tr key={x.id}>
                    <td>{x.name}</td>
                    <td style={{ fontSize: 12.5 }}>{x.fields.map((k) => FIELD[k] + ": " + (x.from[k] || "—") + " → " + (x.to[k] || "—")).join("; ")}</td>
                    <td style={{ fontSize: 12.5 }}>
                      <span style={{ background: bg, color: fg, borderRadius: 999, padding: "2px 8px", fontWeight: 600 }}>{l}</span>{" "}
                      {x.decidedBy}{x.effectiveDate ? " · з " + fmt(x.effectiveDate) : ""}{x.comment ? " · " + x.comment : ""}
                      {x.status === "dismissed" && <> · <button className="link" onClick={() => decide("reopen", { id: x.id })}>повернути</button></>}
                    </td>
                    <td className="num" style={{ fontSize: 12.5 }}>{x.tagBefore || x.tagAfter ? (x.tagBefore || "—") + " → " + (x.tagAfter || "—") : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
