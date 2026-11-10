"use client";
import React, { useMemo, useState } from "react";
import Info from "./Info";
import { allocAt } from "../lib/alloc";
import { onStaff, monthlySeries, turnover12, tenure, byGroup, upcoming, addDays } from "../lib/hrmetrics";

/* HR та рекрутинг: штат, найми, звільнення, плинність, стаж, нерозподілені, мобільність.
   Усе рахується з карток співробітників (hiredOn / leftOn з PeopleForce) і журналу переведень. */

const C = { surface: "#FFFFFF", ink: "#0F172A", ink2: "#334155", muted: "#64748B", line: "#DDE3EC", lineSoft: "#EEF2F6",
  signal: "#2563EB", signalSoft: "#EFF6FF", warn: "#B45309", warnSoft: "#FFF7ED", stop: "#B91C1C", good: "#15803D" };
const card = { background: C.surface, border: "1px solid " + C.line, borderRadius: 10, boxShadow: "0 1px 2px rgba(15,23,42,.04)" };
const MONTHS = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
const pct = (x) => (x * 100).toFixed(x < 0.1 ? 1 : 0).replace(".", ",") + "%";
const fmtD = (s) => (s ? s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4) : "—");
const plural = (n, a, b, c) => { const m = n % 100; if (m > 10 && m < 20) return c; const k = n % 10; return k === 1 ? a : k > 1 && k < 5 ? b : c; };
const r1 = (x) => String(Math.round(x * 10) / 10).replace(".", ",");

function Kpi({ label, value, sub, tone }) {
  return (
    <div style={{ ...card, padding: "14px 16px", flex: "1 1 150px", minWidth: 150 }}>
      <div style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>{label}</div>
      <div className="num" style={{ fontSize: 26, fontWeight: 700, color: tone || C.ink, marginTop: 4, letterSpacing: "-0.02em" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function HrMetrics({ employees, transfers, teams, today, onOpenCard, onExport }) {
  const [group, setGroup] = useState("team");

  const m = useMemo(() => {
    const series = monthlySeries(employees, today, 12);
    const t12 = turnover12(employees, today);
    const ten = tenure(employees, today);
    const staff = employees.filter((e) => onStaff(e, today));
    const hires12 = employees.filter((e) => e.hiredOn && e.hiredOn > addDays(today, -365) && e.hiredOn <= today).length;
    const teamName = (id) => (teams.find((x) => x.id === id) || {}).name || "";
    const groups = {
      team: byGroup(employees, today, (e) => teamName(e.teamId || (e.teamHist && e.teamHist.length ? e.teamHist[e.teamHist.length - 1].teamId : "")) || "Без команди"),
      division: byGroup(employees, today, (e) => e.division || e.department || "Без БЮ"),
      position: byGroup(employees, today, (e) => e.position || "Без посади").slice(0, 20),
    };
    const bench = staff.map((e) => ({ e, p: Math.max(0, 100 - allocAt(e, transfers, today).reduce((t, x) => t + x.percent, 0)) }))
      .filter((x) => x.p > 0).sort((a, b) => b.p - a.p);
    const benchFte = bench.reduce((s, x) => s + x.p / 100, 0);
    const mob = series.map((s) => ({ key: s.key, n: transfers.filter((t) => !t.cancelled && t.effectiveDate && t.effectiveDate.slice(0, 7) === s.key).length }));
    const moved = new Set(transfers.filter((t) => !t.cancelled && t.effectiveDate > addDays(today, -365) && t.effectiveDate <= today).map((t) => t.employeeId));
    const movedShare = staff.length ? staff.filter((e) => moved.has(e.id)).length / staff.length : 0;
    return { series, t12, ten, staff, hires12, groups, bench, benchFte, mob, movedShare, up: upcoming(employees, today, 60) };
  }, [employees, transfers, teams, today]);

  const maxBar = Math.max(1, ...m.series.map((s) => Math.max(s.hires, s.leavers)));
  const maxTen = Math.max(1, ...m.ten.buckets.map((b) => b.count));
  const maxMob = Math.max(1, ...m.mob.map((x) => x.n));
  const net12 = m.hires12 - m.t12.leavers;
  const GROUPS = [["team", "Команда"], ["division", "БЮ"], ["position", "Посада"]];
  const rows = m.groups[group];
  const label = (s) => MONTHS[s.m - 1] + (s.m === 1 ? " " + String(s.y).slice(2) : "");

  const exportXlsx = () => onExport && onExport("hr-metrics-" + today + ".xlsx", [
    { name: "По місяцях", freeze: 1, cols: [12, 10, 12, 14, 12, 12],
      rows: [["Місяць", "Найми", "Звільнення", "Штат на кінець", "Баланс", "Плинність"], ...m.series.map((s) => [s.key, s.hires, s.leavers, s.headcount, s.net, Number((s.turnover * 100).toFixed(1))])] },
    ...GROUPS.map(([k, l]) => ({ name: l, freeze: 1, cols: [30, 10, 10, 12, 12],
      rows: [[l, "Штат", "Найми 12 міс", "Звільнення 12 міс", "Плинність %"], ...m.groups[k].map((g) => [g.name, g.headcount, g.hires, g.leavers, Number((g.turnover * 100).toFixed(1))])] })),
    { name: "Не розподілені", freeze: 1, cols: [30, 30, 10], rows: [["Співробітник", "Посада", "% не розподілено"], ...m.bench.map((x) => [x.e.name, x.e.position || "", Math.round(x.p)])] },
  ]);

  const person = (e) => (
    <button className="link" style={{ color: C.ink, textDecoration: "none", textAlign: "left" }} onClick={() => onOpenCard && onOpenCard(e.id)}>{e.name}</button>
  );

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <section style={{ ...card, padding: "16px 20px" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>HR та рекрутинг</h2>
          <span style={{ color: C.muted, fontSize: 13 }}>станом на {fmtD(today)}, дані за останні 12 місяців</span>
          {onExport && <button className="ghost" style={{ marginLeft: "auto" }} onClick={exportXlsx}>Excel</button>}
        </div>
        <Info title="Як рахується">
          Штат — люди, які працюють на дату (від дати найму до останнього робочого дня). Плинність за 12 міс. — звільнені, поділені на середній штат (на початок і кінець періоду).
          Ранній відтік — звільнені протягом 90 днів після найму. Не розподілені — частка 100%, яка не закрита проєктами за довідником і переведеннями.
          Дати найму й звільнення приходять з PeopleForce; давно звільнених (до першої синхронізації) тут немає, тому історія надійна лише з моменту підключення.
        </Info>
        {m.ten.noHire > 0 && (
          <p style={{ margin: "10px 0 0", background: C.warnSoft, borderRadius: 8, padding: "8px 12px", color: C.warn, fontSize: 12.5 }}>
            У {m.ten.noHire} {plural(m.ten.noHire, "людини", "людей", "людей")} із {m.ten.total} немає дати найму — вони в штаті, але не входять у найми й стаж.
          </p>
        )}
      </section>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Kpi label="Штат зараз" value={m.staff.length} sub={(net12 >= 0 ? "+" : "") + net12 + " за 12 міс."} />
        <Kpi label="Найми · 12 міс." value={m.hires12} />
        <Kpi label="Звільнення · 12 міс." value={m.t12.leavers} />
        <Kpi label="Плинність · 12 міс." value={pct(m.t12.rate)} tone={m.t12.rate > 0.25 ? C.stop : m.t12.rate > 0.15 ? C.warn : C.ink} />
        <Kpi label="Ранній відтік" value={m.t12.early} sub="пішли до 90 днів" tone={m.t12.early ? C.warn : C.ink} />
        <Kpi label="Середній стаж" value={m.ten.known ? r1(m.ten.avgMonths) + " міс." : "—"} sub={m.ten.known ? "медіана " + r1(m.ten.medianMonths) + " міс." : "немає дат найму"} />
      </div>

      <section style={{ ...card, padding: "16px 20px" }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600 }}>Найми й звільнення по місяцях</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, minmax(36px, 1fr))", gap: 6, alignItems: "end" }}>
          {m.series.map((s) => (
            <div key={s.key} style={{ textAlign: "center" }} title={s.key + ": найми " + s.hires + ", звільнення " + s.leavers + ", штат " + s.headcount}>
              <div style={{ display: "flex", gap: 3, alignItems: "flex-end", justifyContent: "center", height: 90 }}>
                <div style={{ width: 12, height: Math.max(s.hires ? 3 : 0, (s.hires / maxBar) * 80), background: C.signal, borderRadius: 3 }} />
                <div style={{ width: 12, height: Math.max(s.leavers ? 3 : 0, (s.leavers / maxBar) * 80), background: C.stop, borderRadius: 3 }} />
              </div>
              <div className="num" style={{ fontSize: 11.5, marginTop: 4 }}>
                <span style={{ color: C.signal }}>{s.hires || "·"}</span> / <span style={{ color: C.stop }}>{s.leavers || "·"}</span>
              </div>
              <div style={{ fontSize: 11.5, color: C.muted }}>{label(s)}</div>
              <div className="num" style={{ fontSize: 11, color: C.muted }}>{s.headcount}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 10, fontSize: 12, color: C.muted }}>
          <span><span style={{ color: C.signal }}>■</span> найми</span><span><span style={{ color: C.stop }}>■</span> звільнення</span><span>нижній рядок — штат на кінець місяця</span>
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <section style={{ ...card, padding: "16px 20px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600 }}>Стаж поточного штату</h3>
          {m.ten.known === 0 ? <p style={{ margin: 0, color: C.muted }}>Немає дат найму.</p> : m.ten.buckets.map((b) => (
            <div key={b.label} style={{ display: "grid", gridTemplateColumns: "80px 1fr 36px", gap: 10, alignItems: "center", padding: "4px 0", fontSize: 13 }}>
              <span style={{ color: C.ink2 }}>{b.label}</span>
              <div style={{ background: C.lineSoft, borderRadius: 4, height: 10 }}><div style={{ width: (b.count / maxTen) * 100 + "%", background: C.signal, height: 10, borderRadius: 4 }} /></div>
              <span className="num" style={{ textAlign: "right" }}>{b.count}</span>
            </div>
          ))}
        </section>

        <section style={{ ...card, padding: "16px 20px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600 }}>Мобільність: переведення по місяцях</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 4, alignItems: "end", height: 80 }}>
            {m.mob.map((x, i) => (
              <div key={x.key} title={x.key + ": " + x.n} style={{ height: Math.max(x.n ? 3 : 0, (x.n / maxMob) * 70), background: C.signal, borderRadius: 3, opacity: 0.85 }} aria-label={m.series[i].key + ": " + x.n} />
            ))}
          </div>
          <div style={{ fontSize: 12.5, color: C.muted, marginTop: 8 }}>
            Усього за 12 міс.: {m.mob.reduce((s, x) => s + x.n, 0)} · змінили проєкт {pct(m.movedShare)} штату
          </div>
        </section>
      </div>

      <section style={{ ...card, overflow: "hidden" }}>
        <div style={{ padding: "14px 20px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Розріз</h3>
          {GROUPS.map(([k, l]) => (
            <button key={k} onClick={() => setGroup(k)} aria-pressed={group === k}
              style={{ cursor: "pointer", padding: "5px 12px", borderRadius: 16, fontSize: 12.5, border: "1px solid " + (group === k ? C.ink : C.line), background: group === k ? C.ink : C.surface, color: group === k ? "#fff" : C.ink2 }}>{l}</button>
          ))}
        </div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>{GROUPS.find((x) => x[0] === group)[1]}</th><th style={{ textAlign: "right" }}>Штат</th><th style={{ textAlign: "right" }}>Найми</th><th style={{ textAlign: "right" }}>Звільнення</th><th style={{ textAlign: "right" }}>Плинність</th></tr></thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.name}>
                  <td style={{ fontWeight: 500 }}>{g.name}</td>
                  <td className="num" style={{ textAlign: "right" }}>{g.headcount}</td>
                  <td className="num" style={{ textAlign: "right", color: g.hires ? C.signal : C.muted }}>{g.hires || "—"}</td>
                  <td className="num" style={{ textAlign: "right", color: g.leavers ? C.stop : C.muted }}>{g.leavers || "—"}</td>
                  <td className="num" style={{ textAlign: "right", color: g.turnover > 0.25 ? C.stop : g.turnover > 0.15 ? C.warn : C.ink2 }}>{g.leavers ? pct(g.turnover) : "—"}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={5} style={{ padding: 24, textAlign: "center", color: C.muted }}>Немає даних.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <section style={{ ...card, padding: "16px 20px" }}>
          <h3 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 600 }}>Не розподілені</h3>
          <div style={{ color: C.muted, fontSize: 12.5, marginBottom: 8 }}>
            {m.bench.length ? m.bench.length + " " + plural(m.bench.length, "людина", "людини", "людей") + " · " + r1(m.benchFte) + " ставки. Спершу розподіліть їх, а вже потім відкривайте вакансії." : "Усі розподілені."}
          </div>
          {m.bench.slice(0, 12).map((x) => (
            <div key={x.e.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "5px 0", borderTop: "1px solid " + C.lineSoft, fontSize: 13 }}>
              <span>{person(x.e)}<span style={{ color: C.muted }}>{x.e.position ? " · " + x.e.position : ""}</span></span>
              <span className="num" style={{ color: C.warn, fontWeight: 600 }}>{Math.round(x.p)}%</span>
            </div>
          ))}
          {m.bench.length > 12 && <div style={{ color: C.muted, fontSize: 12.5, marginTop: 6 }}>…і ще {m.bench.length - 12}. Повний список — в Excel.</div>}
        </section>

        <section style={{ ...card, padding: "16px 20px" }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 600 }}>Найближчі 60 днів</h3>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: C.muted, margin: "4px 0" }}>Виходять на роботу (з останніх 30 днів)</div>
          {m.up.joined.length ? m.up.joined.map((e) => (
            <div key={e.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "4px 0", fontSize: 13 }}><span>{person(e)}</span><span className="num" style={{ color: C.signal }}>{fmtD(e.hiredOn)}</span></div>
          )) : <div style={{ color: C.muted, fontSize: 13 }}>Нікого.</div>}
          <div style={{ fontSize: 12.5, fontWeight: 600, color: C.muted, margin: "12px 0 4px" }}>Йдуть з компанії</div>
          {m.up.leaving.length ? m.up.leaving.map((e) => (
            <div key={e.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "4px 0", fontSize: 13 }}><span>{person(e)}<span style={{ color: C.muted }}>{e.position ? " · " + e.position : ""}</span></span><span className="num" style={{ color: C.stop }}>{fmtD(e.leftOn)}</span></div>
          )) : <div style={{ color: C.muted, fontSize: 13 }}>Нікого.</div>}
        </section>
      </div>
    </div>
  );
}
