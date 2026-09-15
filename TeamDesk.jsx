"use client";
import React, { useState, useEffect, useMemo, useRef } from "react";
import * as XLSX from "xlsx";

/* Робоче місце відповідального за відсотки: лише свої команди.
Дані приходять з /api/team — сервер не віддає сюди ні чужих команд,
ні переведень, ні довідників. */

const C = {
  paper: "#E7ECF4", surface: "#FFFFFF", ink: "#141E38", ink2: "#37456A",
  muted: "#6F7B99", line: "#C2CDE1", lineSoft: "#DFE5F0",
  signal: "#0C7480", signalSoft: "#DBEFF0",
  warn: "#8A5510", warnSoft: "#F8EBD6",
  stop: "#8A2E44", stopSoft: "#F6E2E7",
};
const SERIF = '"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif';
const SANS = 'ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const fmtDT = (s) => { const d = new Date(s); return isNaN(d) ? "—" : pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const round2 = (n) => String(Number(Number(n).toFixed(2)));
const plural = (n, a, b, c) => { const m = n % 100; if (m > 10 && m < 20) return c; const k = n % 10; return k === 1 ? a : k > 1 && k < 5 ? b : c; };
const lastDay = (y, m) => new Date(y, m, 0).getDate();
const periodKey = (p) => p.y + "-" + pad(p.m) + "-H" + p.half;
const periodOf = (isoDate) => ({ y: +isoDate.slice(0, 4), m: +isoDate.slice(5, 7), half: +isoDate.slice(8, 10) <= 15 ? 1 : 2 });
const periodLabel = (p) => MONTHS[p.m - 1] + " " + p.y + ", " + (p.half === 1 ? "01–15" : "16–" + lastDay(p.y, p.m));
const shiftPeriod = (p, n) => {
  let idx = p.y * 24 + (p.m - 1) * 2 + (p.half - 1) + n;
  const y = Math.floor(idx / 24); idx -= y * 24;
  return { y, m: Math.floor(idx / 2) + 1, half: (idx % 2) + 1 };
};
const entryId = (key, empId) => "en_" + key + "_" + empId;
const sum = (alloc) => (alloc || []).reduce((s, r) => s + (Number(r.percent) || 0), 0);

function tagOf(alloc, codes) {
  const rows = [];
  (alloc || []).filter((x) => x.percent > 0).forEach((x) => {
    const code = (codes || {})[x.project] || "";
    const found = code && rows.find((r) => r.code === code);
    if (found) found.raw += x.percent; else rows.push({ code, raw: x.percent });
  });
  const s = rows.reduce((a, r) => a + r.raw, 0) || 1;
  rows.forEach((r) => { const v = (r.raw * 100) / s; r.pct = Math.floor(v); r.rest = v - r.pct; });
  let left = 100 - rows.reduce((a, r) => a + r.pct, 0);
  rows.slice().sort((a, b) => b.rest - a.rest).forEach((r) => { if (left > 0) { r.pct++; left--; } });
  return rows.filter((r) => r.pct > 0).map((r) => (r.code || "?") + "-" + r.pct).join(",");
}

async function call(method, token, body) {
  const res = await fetch("/api/team", {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || "HTTP " + res.status); e.status = res.status; e.data = data; throw e; }
  return data;
}

export default function TeamDesk({ user, token, onSignOut }) {
  const today = iso(new Date());
  const [data, setData] = useState(null);
  const [entries, setEntries] = useState([]);
  const [period, setPeriod] = useState(periodOf(today));
  const [teamId, setTeamId] = useState("");
  const [dirty, setDirty] = useState({});
  const [saving, setSaving] = useState("ok");
  const [toast, setToast] = useState(null);
  const [compact, setCompact] = useState(false);
  const dirtyRef = useRef({});
  dirtyRef.current = dirty;
  const entriesRef = useRef([]);
  entriesRef.current = entries;

  const pKey = periodKey(period);

  function apply(d) {
    setData(d);
    // Не затираємо рядки, які людина саме редагує.
    setEntries((cur) => {
      const keep = cur.filter((x) => dirtyRef.current[x.id]);
      return [...(d.entries || []).filter((x) => !dirtyRef.current[x.id]), ...keep];
    });
    setTeamId((cur) => (d.teams || []).some((t) => t.id === cur) ? cur : ((d.teams || [])[0] || {}).id || "");
  }
  function fail(e) {
    if (e.status === 401) { onSignOut(); return; }
    setSaving("error");
    setToast(e.message);
    if (e.data && e.data.teams) apply(e.data);
  }
  async function load() {
    try { apply(await call("GET", token)); setSaving("ok"); } catch (e) { fail(e); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden && !Object.keys(dirtyRef.current).length) load(); }, 60000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 5000); return () => clearTimeout(id); }, [toast]);

  const team = (data?.teams || []).find((t) => t.id === teamId);
  const members = (data?.members || []).filter((m) => m.teamId === teamId);
  const codes = data?.codes || {};
  const sub = team ? (team.submitted || {})[pKey] : null;
  const locked = !!sub;

  const allocIn = (empId, key) => ((entries.find((x) => x.id === entryId(key, empId)) || {}).alloc) || [];
  const cellValue = (empId, project) => { const r = allocIn(empId, pKey).find((x) => x.project === project); return r ? r.percent : ""; };
  const rowTotal = (empId) => sum(allocIn(empId, pKey));
  const filled = members.filter((m) => rowTotal(m.id) > 0).length;

  const cols = useMemo(() => {
    const all = data?.projects || [];
    if (!compact) return all;
    const used = new Set();
    members.forEach((m) => entries.filter((x) => x.employeeId === m.id).forEach((x) => (x.alloc || []).forEach((r) => r.percent > 0 && used.add(r.project))));
    return all.filter((p) => used.has(p));
  }, [data, compact, members, entries]);

  async function save(rows, submit, key = pKey, tid = teamId) {
    if (!tid) return null;
    setSaving("saving");
    try {
      const d = await call("PUT", token, { teamId: tid, periodKey: key, rows, submit: !!submit });
      const remaining = { ...dirtyRef.current };
      rows.forEach((r) => delete remaining[entryId(key, r.employeeId)]);
      dirtyRef.current = remaining;
      setDirty(remaining);
      apply(d);
      setSaving("ok");
      return d;
    } catch (e) {
      // Сервер відхилив рядки (період подано, людину прибрали з команди тощо):
      // не пробуємо ще раз, а показуємо актуальний стан.
      const remaining = { ...dirtyRef.current };
      rows.forEach((r) => delete remaining[entryId(key, r.employeeId)]);
      dirtyRef.current = remaining;
      setDirty(remaining);
      fail(e);
      if (e.status !== 401 && !(e.data && e.data.teams)) load();
      return null;
    }
  }

  // Автозбереження: через секунду після останньої правки.
  useEffect(() => {
    if (!Object.keys(dirty).length) return;
    const t = setTimeout(() => {
      // Групуємо за командою й періодом: людина могла перегорнути період до збереження.
      const groups = {};
      entriesRef.current.filter((x) => dirtyRef.current[x.id]).forEach((x) => {
        const m = (data?.members || []).find((y) => y.id === x.employeeId);
        if (!m) return;
        const k = m.teamId + "|" + x.periodKey;
        (groups[k] = groups[k] || []).push({ employeeId: x.employeeId, alloc: x.alloc });
      });
      Object.entries(groups).forEach(([k, rows]) => { const [tid, key] = k.split("|"); save(rows, false, key, tid); });
    }, 900);
    return () => clearTimeout(t);
  }, [dirty]);

  function setCell(empId, project, value) {
    if (locked) return;
    const v = value === "" ? 0 : Math.max(0, Math.min(100, Number(value)));
    const id = entryId(pKey, empId);
    setEntries((p) => {
      const old = p.find((x) => x.id === id);
      const rows = (old ? old.alloc : []).filter((r) => r.project !== project);
      if (v > 0) rows.push({ project, percent: v });
      const next = { id, periodKey: pKey, employeeId: empId, alloc: rows };
      return old ? p.map((x) => (x.id === id ? next : x)) : [...p, next];
    });
    setDirty((d) => ({ ...d, [id]: true }));
  }

  async function copyPrev() {
    if (locked) return;
    const prev = periodKey(shiftPeriod(period, -1));
    const rows = members.filter((m) => !rowTotal(m.id) && allocIn(m.id, prev).length)
      .map((m) => ({ employeeId: m.id, alloc: allocIn(m.id, prev).map((r) => ({ ...r })) }));
    if (!rows.length) return setToast("Немає що переносити: попередній період порожній або цей уже заповнений.");
    const d = await save(rows, false);
    if (d) setToast("Перенесли " + rows.length + " " + plural(rows.length, "рядок", "рядки", "рядків"));
  }

  async function submitPeriod() {
    const bad = members.filter((m) => Math.abs(rowTotal(m.id) - 100) > 0.01);
    if (bad.length) return setToast("Не подамо: у " + bad.length + " " + plural(bad.length, "людини", "людей", "людей") + " сума не 100%.");
    if (!window.confirm("Подати період «" + periodLabel(period) + "» для команди «" + team.name + "»? Після подання змінити відсотки зможе лише адміністратор.")) return;
    const rows = members.map((m) => ({ employeeId: m.id, alloc: allocIn(m.id, pKey) }));
    const d = await save(rows, true);
    if (d) setToast("Період подано: " + team.name + ", " + periodLabel(period));
  }

  function exportXlsx() {
    if (!team) return;
    const wb = XLSX.utils.book_new();
    const add = (name, rows, cols) => {
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = cols.map((w) => ({ wch: w }));
      ws["!views"] = [{ state: "frozen", ySplit: 1 }];
      XLSX.utils.book_append_sheet(wb, ws, name);
    };
    add("Табель " + pKey, [
      ["Співробітник", "Посада", ...(data.projects || []), "Разом, %", "Тег"],
      ...members.map((m) => [m.name, m.position, ...(data.projects || []).map((p) => cellValue(m.id, p) || ""), rowTotal(m.id), tagOf(allocIn(m.id, pKey), codes)]),
    ], [26, 24, ...(data.projects || []).map(() => 12), 10, 36]);
    add("Історія", [
      ["Період", "Співробітник", "Тег", "Разом, %", "Оновив", "Коли"],
      ...entries.filter((x) => members.some((m) => m.id === x.employeeId))
        .sort((a, b) => b.periodKey.localeCompare(a.periodKey))
        .map((x) => [x.periodKey, (members.find((m) => m.id === x.employeeId) || {}).name || "", tagOf(x.alloc, codes), sum(x.alloc), x.updatedBy || "", x.updatedAt ? fmtDT(x.updatedAt) : ""]),
    ], [14, 26, 36, 10, 22, 18]);
    XLSX.writeFile(wb, "zvit-" + team.name.replace(/[^\p{L}\p{N}]+/gu, "-") + "-" + pKey + ".xlsx");
  }

  const card = { background: C.surface, border: "1px solid " + C.line, borderRadius: 4 };
  const addBtn = { cursor: "pointer", background: C.ink, color: "#fff", border: "none", borderRadius: 3, padding: "9px 16px", whiteSpace: "nowrap" };
  const css = `
    .tm *, .tm *::before, .tm *::after { box-sizing: border-box; }
    .tm button, .tm input { font: inherit; color: inherit; }
    .tm :focus-visible { outline: 2px solid ${C.signal}; outline-offset: 2px; }
    .tm table { border-collapse: collapse; width: 100%; }
    .tm th, .tm td { text-align: left; padding: 10px 12px; vertical-align: middle; }
    .tm th { font-size: 12px; font-weight: 600; color: ${C.muted}; border-bottom: 1px solid ${C.line}; }
    .tm td { border-bottom: 1px solid ${C.lineSoft}; font-size: 13.5px; }
    .tm .num { font-variant-numeric: tabular-nums; }
    .tm .ghost { cursor: pointer; background: none; border: 1px dashed ${C.line}; border-radius: 3px; padding: 8px 12px; color: ${C.ink2}; }
    .tm .ghost:hover { border-color: ${C.signal}; color: ${C.signal}; }
    .tm .link { cursor: pointer; background: none; border: none; padding: 0; color: ${C.signal}; text-decoration: underline; }
    .tm input[type="number"] { width: 100%; border: 1px solid ${C.line}; border-radius: 3px; }
  `;

  return (
    <div className="tm" style={{ background: C.paper, minHeight: "100vh", fontFamily: SANS, color: C.ink, fontSize: 14 }}>
      <style>{css}</style>
      <header style={{ borderBottom: "1px solid " + C.line, background: C.surface }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "18px 24px", display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontFamily: SERIF, fontSize: 24, fontWeight: 600 }}>Відсотки залученості</h1>
          <span style={{ color: C.muted, fontSize: 13 }}>доступ лише до вашої команди</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "center", fontSize: 13 }}>
            <span style={{ color: C.ink2 }}>{user.name}</span>
            <span style={{ color: saving === "error" ? C.stop : C.muted }}>
              {saving === "saving" ? "зберігаємо…" : saving === "error" ? "не збережено" : "збережено"}
            </span>
            <button className="link" onClick={onSignOut}>вийти</button>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: 24, display: "grid", gap: 20 }}>
        {!data && <section style={{ ...card, padding: 30, color: C.muted }}>Завантажуємо вашу команду…</section>}

        {data && !data.teams.length && (
          <section style={{ ...card, padding: 30 }}>
            <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 20 }}>За вами поки не закріплено жодної команди</h2>
            <p style={{ color: C.ink2, marginBottom: 0 }}>
              Попросіть адміністратора вписати «{user.name}» у поле «Відповідальний за %» потрібної команди
              (Довідник → Налаштування). Ім'я має збігатися буква в букву.
            </p>
          </section>
        )}

        {data && data.teams.length > 0 && (
          <>
            <section style={{ ...card, padding: "16px 20px" }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                {data.teams.length > 1 ? (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {data.teams.map((t) => (
                      <button key={t.id} onClick={() => setTeamId(t.id)} aria-pressed={t.id === teamId}
                        style={{ cursor: "pointer", padding: "6px 12px", borderRadius: 3, fontSize: 13, border: "1px solid " + (t.id === teamId ? C.ink2 : C.line), background: t.id === teamId ? C.ink : C.surface, color: t.id === teamId ? "#fff" : C.ink2 }}>
                        {t.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 21, fontWeight: 600 }}>{team?.name}</h2>
                )}
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 8 }}>
                  <button className="ghost" onClick={() => setPeriod((p) => shiftPeriod(p, -1))} aria-label="Попередній період">←</button>
                  <span className="num" style={{ fontWeight: 600, minWidth: 210, textAlign: "center" }}>{periodLabel(period)}</span>
                  <button className="ghost" onClick={() => setPeriod((p) => shiftPeriod(p, 1))} aria-label="Наступний період">→</button>
                </div>
                {pKey !== periodKey(periodOf(today)) && <button className="link" onClick={() => setPeriod(periodOf(today))}>до поточного</button>}
                <button onClick={exportXlsx} style={{ marginLeft: "auto", cursor: "pointer", padding: "8px 14px", borderRadius: 3, border: "1px solid " + C.line, background: C.surface, color: C.ink2 }}>
                  Звіт в Excel
                </button>
              </div>
              <p style={{ margin: "10px 0 0", color: C.muted, fontSize: 12.5 }}>
                Внесіть відсотки кожної людини за 01–15 і 16–кінець місяця так, щоб у рядку було рівно 100%, і натисніть «Подати період».
                Зміни зберігаються автоматично.
              </p>
            </section>

            {team && (
              <section style={{ ...card, overflow: "hidden" }}>
                <div style={{ padding: "14px 20px", borderBottom: "1px solid " + C.lineSoft, display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                  {members.length > 0 && (
                    <span className="num" style={{ fontSize: 13, color: filled === members.length ? C.signal : C.warn }}>
                      заповнено {filled} з {members.length}
                    </span>
                  )}
                  {sub && (
                    <span style={{ background: C.signalSoft, color: C.signal, borderRadius: 3, padding: "2px 8px", fontSize: 12, fontWeight: 600 }}>
                      подано · {sub.by}, {fmtDT(sub.at)}
                    </span>
                  )}
                  <button className="link" style={{ marginLeft: "auto", fontSize: 12.5 }} onClick={() => setCompact((v) => !v)}>
                    {compact ? "усі проєкти" : "лише заповнені"}
                  </button>
                </div>

                {members.length === 0 ? (
                  <p style={{ padding: "18px 20px", margin: 0, color: C.muted }}>До команди ще нікого не прикріплено — людей додає адміністратор.</p>
                ) : cols.length === 0 ? (
                  <p style={{ padding: "18px 20px", margin: 0, color: C.muted }}>
                    {compact ? "У цьому періоді ще нічого не заповнено." : "Проєктів ще немає — їх додає адміністратор у довіднику."}
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
                              <div className="num" style={{ fontWeight: 400, color: C.muted }}>{codes[c] || ""}</div>
                            </th>
                          ))}
                          <th style={{ minWidth: 80, textAlign: "center" }}>Разом</th>
                          <th style={{ minWidth: 180 }}>Тег</th>
                        </tr>
                      </thead>
                      <tbody>
                        {members.map((m) => {
                          const tot = rowTotal(m.id), tg = tagOf(allocIn(m.id, pKey), codes);
                          return (
                            <tr key={m.id}>
                              <td style={{ position: "sticky", left: 0, background: C.surface }}>
                                <div style={{ fontWeight: 600 }}>{m.name}</div>
                                {m.position && <div style={{ color: C.muted, fontSize: 11.5 }}>{m.position}</div>}
                              </td>
                              {cols.map((c) => (
                                <td key={c} style={{ padding: 4 }}>
                                  <input type="number" className="num" min="0" max="100" value={cellValue(m.id, c)} disabled={locked}
                                    onChange={(ev) => setCell(m.id, c, ev.target.value)} aria-label={m.name + ", " + c}
                                    style={{ textAlign: "center", padding: "7px 4px", background: locked ? "#F4F6FA" : C.surface }} />
                                </td>
                              ))}
                              <td className="num" style={{ textAlign: "center", fontWeight: 600, color: Math.abs(tot - 100) < 0.01 ? C.signal : tot === 0 ? C.muted : C.stop }}>
                                {tot ? round2(tot) + "%" : "—"}
                              </td>
                              <td className="num" style={{ fontWeight: 600, color: tg ? C.ink : C.muted, wordBreak: "break-all", fontSize: 12.5 }}>{tg || "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <div style={{ display: "flex", gap: 10, padding: "14px 20px", borderTop: "1px solid " + C.lineSoft, flexWrap: "wrap", alignItems: "center" }}>
                  {!sub ? (
                    <>
                      <button className="ghost" onClick={copyPrev}>Перенести з попереднього періоду</button>
                      {members.length > 0 && <button style={addBtn} onClick={submitPeriod}>Подати період</button>}
                    </>
                  ) : (
                    <span style={{ color: C.muted, fontSize: 12.5 }}>Період подано й закрито. Щоб щось змінити, зверніться до адміністратора.</span>
                  )}
                </div>
              </section>
            )}
          </>
        )}
      </main>

      {toast && (
        <div role="status" style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 24, background: C.ink, color: "#fff", padding: "12px 18px", borderRadius: 4, boxShadow: "0 8px 24px rgba(20,30,56,.24)", maxWidth: "90vw", zIndex: 30 }}>
          {toast}
        </div>
      )}
    </div>
  );
}
