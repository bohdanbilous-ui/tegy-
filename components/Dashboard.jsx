"use client";
import React, { useState, useEffect, useMemo, useRef } from "react";

/* Дашборд адміністратора: ставки по продуктах за місяцями, динаміка переведень,
   хто затримує подання табеля, HR-метрики. Усе рахується з тих самих даних,
   що й решта застосунку; нічого окремо не зберігається. */

const C = {
  paper: "#E7ECF4", surface: "#FFFFFF", ink: "#141E38", ink2: "#37456A",
  muted: "#6F7B99", line: "#C2CDE1", lineSoft: "#DFE5F0", grid: "#E6EAF2",
  signal: "#0C7480", signalSoft: "#DBEFF0",
};
const SERIF = '"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif';
// Категорійна палітра (перевірена на кольорову сліпоту), порядок фіксований.
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7"];
const OTHER = "#b4b2a9";
const POS = "#2a78d6", NEG = "#e34948";
const STATUS = {
  ok: { color: "#0ca30c", icon: "✓" },
  late: { color: "#ec835a", icon: "!" },
  missed: { color: "#d03b3b", icon: "✕" },
  open: { color: "#9aa3b8", icon: "…" },
};
const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
const MON = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];

const pad = (n) => String(n).padStart(2, "0");
const lastDay = (y, m) => new Date(y, m, 0).getDate();
const localDate = (s) => { const d = new Date(s); return isNaN(d) ? "" : d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
const dayDiff = (a, b) => Math.round((Date.parse(a + "T00:00:00") - Date.parse(b + "T00:00:00")) / 864e5);
const plusDays = (s, n) => { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
const fmt = (s) => (s ? s.slice(8, 10) + "." + s.slice(5, 7) : "");
const nf1 = (v) => (Math.round(v * 10) / 10).toLocaleString("uk-UA");
const pct = (a, b) => (b ? Math.round((a * 100) / b) : null);
const share = (a, b) => (b ? Math.round((a * 100) / b) + "%" : "—");
const sumAlloc = (a) => (a || []).reduce((s, r) => s + (Number(r.percent) || 0), 0);
const plural = (n, a, b, c) => { const m = n % 100; if (m > 10 && m < 20) return c; const k = n % 10; return k === 1 ? a : k > 1 && k < 5 ? b : c; };

function niceScale(max) {
  const raw = Math.max(max, 1e-9) / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const list = [];
  for (let v = 0; v <= top + 1e-9; v += step) list.push(Math.round(v * 1000) / 1000);
  return { top, list };
}

function useWidth(fallback) {
  const ref = useRef(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// Верхні кути заокруглені, основа пряма.
const colPath = (x, y, w, h, r) => {
  const rr = Math.min(r, h, w / 2);
  if (h <= 0) return "";
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
};

function Legend({ series }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", margin: "0 0 10px" }}>
      {series.map((s) => (
        <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.ink2 }}>
          <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: "inline-block" }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ tip }) {
  if (!tip) return null;
  return (
    <div role="status" style={{
      position: "absolute", left: tip.x, top: tip.y, transform: tip.flip ? "translate(-100%, -100%)" : "translate(0, -100%)",
      background: C.surface, border: "1px solid " + C.line, borderRadius: 4, padding: "8px 10px",
      boxShadow: "0 6px 18px rgba(20,30,56,.14)", pointerEvents: "none", zIndex: 5, minWidth: 150, fontSize: 12.5,
    }}>
      <div style={{ color: C.muted, marginBottom: 4 }}>{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, lineHeight: 1.6, fontWeight: r.strong ? 600 : 400 }}>
          {r.color && <span aria-hidden="true" style={{ width: 12, height: 2, background: r.color, display: "inline-block" }} />}
          <span className="num" style={{ color: C.ink, fontWeight: 600, minWidth: 34 }}>{r.value}</span>
          <span style={{ color: C.ink2 }}>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/* Стовпчики з накопиченням. months: [{ key, label, note, values: { series: number } }] */
function StackedColumns({ months, series, unit, height = 260, emptyText }) {
  const [ref, width] = useWidth(640);
  const [tip, setTip] = useState(null);
  const [hover, setHover] = useState(null);
  const m = { l: 44, r: 8, t: 18, b: 26 };
  const totals = months.map((mo) => series.reduce((s, x) => s + (mo.values[x.key] || 0), 0));
  const max = Math.max(0, ...totals);
  const { top, list } = niceScale(max || 1);
  const iw = width - m.l - m.r, ih = height - m.t - m.b;
  const band = iw / Math.max(1, months.length);
  const bw = Math.min(24, band * 0.6);
  const y = (v) => m.t + ih - (v / top) * ih;
  const showTip = (i, ev) => {
    const mo = months[i];
    const box = ref.current.getBoundingClientRect();
    const px = (ev && ev.clientX != null ? ev.clientX - box.left : m.l + band * i + band / 2);
    const rows = series.filter((s) => mo.values[s.key]).slice().reverse()
      .map((s) => ({ color: s.color, label: s.label, value: nf1(mo.values[s.key]) }));
    rows.push({ label: "разом" + (unit ? ", " + unit : ""), value: nf1(totals[i]), strong: true });
    setHover(i);
    setTip({ x: px + 12, y: Math.max(40, y(totals[i]) - 4), flip: px > width * 0.6, title: mo.label + (mo.note ? " · " + mo.note : ""), rows });
  };
  const clear = () => { setTip(null); setHover(null); };
  return (
    <div ref={ref} style={{ position: "relative" }}>
      {max === 0 ? (
        <p style={{ color: C.muted, margin: "30px 0", textAlign: "center" }}>{emptyText || "Даних за цей період немає."}</p>
      ) : (
        <svg width={width} height={height} role="img" aria-label={"Стовпчикова діаграма по місяцях" + (unit ? ", " + unit : "")} style={{ display: "block" }}>
          {list.map((v) => (
            <g key={v}>
              <line x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} stroke={C.grid} strokeWidth="1" />
              <text x={m.l - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill={C.muted} className="num">{nf1(v)}</text>
            </g>
          ))}
          {months.map((mo, i) => {
            const cx = m.l + band * i + band / 2;
            let acc = 0;
            const segs = series.filter((s) => mo.values[s.key] > 0);
            return (
              <g key={mo.key} tabIndex={0} aria-label={mo.label + ": " + nf1(totals[i]) + (unit ? " " + unit : "")}
                onPointerMove={(ev) => showTip(i, ev)} onPointerLeave={clear} onFocus={() => showTip(i)} onBlur={clear}
                style={{ outline: "none", cursor: "default" }}>
                <rect x={m.l + band * i} y={m.t} width={band} height={ih} fill={hover === i ? "#F3F6FB" : "transparent"} />
                {segs.map((s, j) => {
                  const v = mo.values[s.key];
                  const y0 = y(acc), y1 = y(acc + v);
                  acc += v;
                  const isTop = j === segs.length - 1;
                  const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
                  return isTop
                    ? <path key={s.key} d={colPath(cx - bw / 2, y1, bw, h, 4)} fill={s.color} />
                    : <rect key={s.key} x={cx - bw / 2} y={y1} width={bw} height={h} fill={s.color} />;
                })}
                <text x={cx} y={height - 8} textAnchor="middle" fontSize="11" fill={hover === i ? C.ink : C.muted}>{mo.short || mo.label}</text>
                {i === months.length - 1 && totals[i] > 0 && (
                  <text x={cx} y={y(totals[i]) - 6} textAnchor="middle" fontSize="11" fill={C.ink2} fontWeight="600" className="num">{nf1(totals[i])}</text>
                )}
              </g>
            );
          })}
          <line x1={m.l} x2={width - m.r} y1={m.t + ih} y2={m.t + ih} stroke={C.line} strokeWidth="1" />
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

/* Горизонтальні стовпчики, один колір. items: [{ label, value, hint }] */
function BarList({ items, color = SERIES[0], format = (v) => v }) {
  const max = Math.max(1, ...items.map((x) => x.value));
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {items.map((x) => (
        <div key={x.label} title={x.hint || ""} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 38%) 1fr auto", gap: 10, alignItems: "center", fontSize: 13 }}>
          <span style={{ color: C.ink2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.label}</span>
          <span style={{ height: 12, background: "transparent", display: "block" }}>
            <span style={{ display: "block", height: "100%", width: (x.value / max) * 100 + "%", minWidth: x.value ? 3 : 0, maxWidth: "100%", background: color, borderRadius: "0 4px 4px 0" }} />
          </span>
          <span className="num" style={{ color: C.ink, fontWeight: 600, minWidth: 34, textAlign: "right" }}>{format(x.value)}</span>
        </div>
      ))}
    </div>
  );
}

/* Розбіжні стовпчики навколо нуля: прийшло (синій) / пішло (червоний). */
function DivergingList({ items }) {
  const max = Math.max(0.01, ...items.map((x) => Math.abs(x.value)));
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {items.map((x) => {
        const w = (Math.abs(x.value) / max) * 50;
        return (
          <div key={x.label} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 34%) 1fr 56px", gap: 10, alignItems: "center", fontSize: 13 }}>
            <span style={{ color: C.ink2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.label}</span>
            <span style={{ position: "relative", height: 12, display: "block" }}>
              <span style={{ position: "absolute", left: "50%", top: -3, bottom: -3, width: 1, background: C.line }} />
              <span style={{
                position: "absolute", top: 0, height: 12, width: w + "%", minWidth: x.value ? 3 : 0,
                left: x.value >= 0 ? "50%" : 50 - w + "%", background: x.value >= 0 ? POS : NEG,
                borderRadius: x.value >= 0 ? "0 4px 4px 0" : "4px 0 0 4px",
              }} />
            </span>
            <span className="num" style={{ color: C.ink, fontWeight: 600, textAlign: "right" }}>{x.value > 0 ? "+" : x.value < 0 ? "−" : ""}{nf1(Math.abs(x.value))}</span>
          </div>
        );
      })}
    </div>
  );
}

function Tile({ label, value, sub, delta }) {
  return (
    <div style={{ background: C.surface, border: "1px solid " + C.line, borderRadius: 4, padding: "14px 16px", minWidth: 0 }}>
      <div style={{ fontSize: 12.5, color: C.muted }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 600, color: C.ink, margin: "4px 0 2px", lineHeight: 1.15 }}>{value}</div>
      {delta && <div style={{ fontSize: 12, color: C.ink2 }}>{delta}</div>}
      {sub && <div style={{ fontSize: 12, color: C.muted }}>{sub}</div>}
    </div>
  );
}

function Metric({ title, value, detail, why }) {
  return (
    <div style={{ borderTop: "1px solid " + C.lineSoft, padding: "12px 0", display: "grid", gridTemplateColumns: "1fr auto", gap: "2px 16px" }}>
      <div style={{ fontWeight: 600, color: C.ink }}>{title}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: C.ink, textAlign: "right" }}>{value}</div>
      <div style={{ gridColumn: "1 / -1", fontSize: 12.5, color: C.ink2 }}>{detail}</div>
      {why && <div style={{ gridColumn: "1 / -1", fontSize: 12, color: C.muted }}>{why}</div>}
    </div>
  );
}

function DataTable({ head, rows }) {
  return (
    <div style={{ overflowX: "auto", marginTop: 10 }}>
      <table>
        <thead><tr>{head.map((h, i) => <th key={i} style={{ textAlign: i ? "right" : "left", whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => <td key={j} className={j ? "num" : ""} style={{ textAlign: j ? "right" : "left", whiteSpace: "nowrap" }}>{c}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function StatusChip({ kind, text }) {
  const s = STATUS[kind];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: C.ink2, whiteSpace: "nowrap" }}>
      <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: 8, background: s.color, color: "#fff", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{s.icon}</span>
      {text}
    </span>
  );
}

export default function Dashboard({ employees, transfers, entries, teams, codes, fin, today, allocAt, monthAllocs, onOpenPerson }) {
  const [range, setRange] = useState(6);
  const [teamId, setTeamId] = useState("all");
  const [tables, setTables] = useState({});
  const toggle = (k) => setTables((t) => ({ ...t, [k]: !t[k] }));

  const ty = +today.slice(0, 4), tm = +today.slice(5, 7);
  const months = useMemo(() => Array.from({ length: range }, (_, i) => {
    const idx = ty * 12 + tm - 1 - (range - 1 - i);
    const y = Math.floor(idx / 12), m = (idx % 12) + 1;
    return { y, m, key: y + "-" + pad(m), label: MONTHS[m - 1] + " " + y, short: MON[m - 1] + (m === 1 ? " " + String(y).slice(2) : "") };
  }), [range, ty, tm]);
  const from = months[0].key + "-01", to = today;
  const prevFrom = (() => { const idx = ty * 12 + tm - 1 - (2 * range - 1); return Math.floor(idx / 12) + "-" + pad((idx % 12) + 1) + "-01"; })();

  const teamName = (id) => (teams.find((t) => t.id === id) || {}).name || "";
  const people = useMemo(() => employees.filter((e) => teamId === "all" || e.teamId === teamId), [employees, teamId]);
  const ids = useMemo(() => new Set(people.map((e) => e.id)), [people]);
  const live = useMemo(() => transfers.filter((t) => !t.cancelled && ids.has(t.employeeId)), [transfers, ids]);
  const inRange = live.filter((t) => t.effectiveDate >= from && t.effectiveDate <= to);
  const inPrev = live.filter((t) => t.effectiveDate >= prevFrom && t.effectiveDate < from);

  // Місячні розподіли (закритий місяць — зі знімка).
  const monthly = useMemo(() => months.map((mo) => ({ ...mo, ...monthAllocs(mo.y, mo.m) })), [months, monthAllocs, entries, fin]);

  // Колір закріплений за кодом продукту за загальним обсягом, а не за фільтром.
  const codeOf = (p) => codes[p] || p;
  const palette = useMemo(() => {
    const tot = {};
    months.forEach((mo) => monthAllocs(mo.y, mo.m).map.forEach((a) => a.forEach((r) => { const k = codeOf(r.project); tot[k] = (tot[k] || 0) + r.percent; })));
    const order = Object.keys(tot).sort((a, b) => tot[b] - tot[a] || a.localeCompare(b));
    const map = {};
    order.slice(0, SERIES.length).forEach((k, i) => (map[k] = SERIES[i]));
    return { map, order };
  }, [months, monthAllocs, codes, entries, fin]);

  const fte = useMemo(() => {
    const projByCode = {};
    const rows = monthly.map((mo) => {
      const values = {};
      mo.map.forEach((a, empId) => {
        if (!ids.has(empId)) return;
        a.forEach((r) => {
          const k = codeOf(r.project);
          (projByCode[k] = projByCode[k] || new Set()).add(r.project);
          const key = palette.map[k] ? k : "__other";
          values[key] = (values[key] || 0) + r.percent / 100;
        });
      });
      const isNow = mo.y === ty && mo.m === tm;
      return { key: mo.key, label: mo.label, short: mo.short, values, note: mo.closed ? "закрито" : isNow ? "місяць триває" : "" };
    });
    const series = palette.order.filter((k) => palette.map[k]).map((k) => {
      const names = [...(projByCode[k] || [])];
      return { key: k, color: palette.map[k], label: k + (names.length && !(names.length === 1 && names[0] === k) ? " · " + names.slice(0, 2).join(", ") + (names.length > 2 ? "…" : "") : "") };
    }).filter((s) => rows.some((r) => r.values[s.key]));
    if (rows.some((r) => r.values.__other)) series.push({ key: "__other", color: OTHER, label: "Інші" });
    return { rows, series };
  }, [monthly, ids, palette, codes]);

  const moves = useMemo(() => {
    const rows = months.map((mo) => {
      const list = inRange.filter((t) => t.effectiveDate.slice(0, 7) === mo.key);
      return { key: mo.key, label: mo.label, short: mo.short, values: { perm: list.filter((t) => !t.temporary).length, temp: list.filter((t) => t.temporary).length } };
    });
    return { rows, series: [{ key: "perm", label: "Постійні", color: SERIES[0] }, { key: "temp", label: "Тимчасові", color: SERIES[1] }] };
  }, [months, inRange]);

  // Хто затримує подання табеля.
  const delays = useMemo(() => {
    const periods = [];
    months.forEach((mo) => [1, 2].forEach((h) => {
      const start = mo.key + (h === 1 ? "-01" : "-16");
      if (start > today) return;
      periods.push({ key: mo.key + "-H" + h, label: fmt(start) + (h === 1 ? "–15" : "–" + lastDay(mo.y, mo.m)), due: mo.key + "-" + (h === 1 ? "15" : pad(lastDay(mo.y, mo.m))) });
    }));
    const shown = periods.slice(-8);
    const rows = teams.filter((t) => (teamId === "all" || t.id === teamId) && employees.some((e) => e.teamId === t.id)).map((t) => {
      let due = 0, ontime = 0, lateDays = [], overdue = 0;
      const cells = {};
      periods.forEach((p) => {
        const sb = (t.submitted || {})[p.key];
        let cell;
        if (sb) {
          const d = dayDiff(localDate(sb.at), p.due);
          due++;
          if (d <= 0) { ontime++; cell = { kind: "ok", text: "вчасно", title: "подано " + fmt(localDate(sb.at)) + " · " + sb.by }; }
          else { lateDays.push(d); cell = { kind: "late", text: "+" + d + " дн", title: "подано " + fmt(localDate(sb.at)) + " · " + sb.by + ", термін " + fmt(p.due) }; }
        } else if (today > p.due) {
          const d = dayDiff(today, p.due);
          due++; overdue++; lateDays.push(d);
          cell = { kind: "missed", text: "не подано", title: "прострочено на " + d + " дн (термін " + fmt(p.due) + ")" };
        } else cell = { kind: "open", text: "до " + fmt(p.due), title: "період триває" };
        cells[p.key] = cell;
      });
      return {
        id: t.id, name: t.name, owner: t.owner || "адміністратор", cells, due, overdue, ok: ontime,
        rate: pct(ontime, due), avgLate: lateDays.length ? Math.round((lateDays.reduce((a, b) => a + b, 0) / lateDays.length) * 10) / 10 : 0,
      };
    }).sort((a, b) => b.overdue - a.overdue || (a.rate ?? 101) - (b.rate ?? 101) || b.avgLate - a.avgLate);
    const all = rows.reduce((s, r) => ({ due: s.due + r.due, ok: s.ok + r.ok }), { due: 0, ok: 0 });
    return { periods: shown, rows, rate: pct(all.ok, all.due) };
  }, [months, teams, teamId, employees, today]);

  // HR-метрики.
  const hr = useMemo(() => {
    const byEmp = {};
    inRange.forEach((t) => (byEmp[t.employeeId] = (byEmp[t.employeeId] || 0) + 1));
    const movers = Object.keys(byEmp).length, repeat = Object.values(byEmp).filter((n) => n >= 2).length;
    const moversPrev = new Set(inPrev.map((t) => t.employeeId)).size;

    // Останній місяць, за який є табель.
    const lastMo = [...monthly].reverse().find((mo) => [...mo.map.keys()].some((id) => ids.has(id)));
    const facts = lastMo ? [...lastMo.map].filter(([id]) => ids.has(id)) : [];
    const multi = facts.filter(([, a]) => a.length > 1).length;
    const avgProjects = facts.length ? facts.reduce((s, [, a]) => s + a.length, 0) / facts.length : 0;
    const focus = facts.length ? facts.reduce((s, [, a]) => s + Math.max(...a.map((r) => r.percent)) / Math.max(1, sumAlloc(a)), 0) / facts.length : 0;

    // План (переведення) проти факту (табель) на середину останнього місяця.
    let compared = 0, mismatched = 0;
    const mismatchList = [];
    if (lastMo) {
      const mid = lastMo.key + "-15";
      facts.forEach(([id, fact]) => {
        const e = employees.find((x) => x.id === id);
        if (!e) return;
        const plan = allocAt(e, mid);
        if (!plan.length) return;
        compared++;
        const keys = new Set([...plan.map((r) => r.project), ...fact.map((r) => r.project)]);
        const pm = Object.fromEntries(plan.map((r) => [r.project, r.percent])), fm = Object.fromEntries(fact.map((r) => [r.project, r.percent]));
        let diff = 0;
        keys.forEach((k) => (diff += Math.abs((pm[k] || 0) - (fm[k] || 0))));
        if (diff / 2 >= 20) { mismatched++; mismatchList.push({ id, name: e.name, diff: Math.round(diff / 2) }); }
      });
    }

    const temp = inRange.filter((t) => t.temporary).length;
    const returns = live.filter((t) => t.temporary && t.returnDate && t.returnDate > today && t.returnDate <= plusDays(today, 30)).length;

    let decided = 0, rejected = 0, waitDays = [], pending = 0;
    live.forEach((t) => (t.approvals || []).forEach((a) => {
      if (a.status === "pending") { pending++; return; }
      if (t.effectiveDate < from || t.effectiveDate > to) return;
      decided++;
      if (a.status === "rejected") rejected++;
      if (a.at && t.createdAt) waitDays.push(Math.max(0, (Date.parse(a.at) - Date.parse(t.createdAt)) / 864e5));
    }));
    const avgWait = waitDays.length ? waitDays.reduce((a, b) => a + b, 0) / waitDays.length : null;

    const leads = inRange.filter((t) => t.createdAt).map((t) => dayDiff(t.effectiveDate, localDate(t.createdAt)));
    const retro = leads.filter((d) => d < 0).length;
    const avgLead = leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null;

    const benchRe = /бенч|bench/i;
    const bench = facts.reduce((s, [, a]) => s + a.filter((r) => benchRe.test(r.project)).reduce((x, r) => x + r.percent / 100, 0), 0);

    const rangeKeys = new Set(months.map((mo) => mo.key));
    const personMonths = monthly.reduce((s, mo) => s + [...mo.map.keys()].filter((id) => ids.has(id)).length, 0);
    const corrected = fin.filter((x) => x.kind === "override" && x.alloc && rangeKeys.has(x.monthKey) && ids.has(x.employeeId)).length;

    const rangeEntries = entries.filter((x) => rangeKeys.has(x.periodKey.slice(0, 7)) && ids.has(x.employeeId) && sumAlloc(x.alloc) > 0);
    const withHours = rangeEntries.filter((x) => Array.isArray(x.hours) && x.hours.length);
    const avgHours = withHours.length ? withHours.reduce((s, x) => s + x.hours.reduce((a, h) => a + (Number(h.hours) || 0), 0), 0) / withHours.length : null;

    const curKey = today.slice(0, 7) + "-H" + (+today.slice(8, 10) <= 15 ? 1 : 2);
    const inTeams = people.filter((e) => e.teamId && teams.some((t) => t.id === e.teamId));
    const filledNow = inTeams.filter((e) => entries.some((x) => x.periodKey === curKey && x.employeeId === e.id && sumAlloc(x.alloc) > 0)).length;

    const reasons = {};
    inRange.forEach((t) => { const r = t.reason || "не вказано"; reasons[r] = (reasons[r] || 0) + 1; });

    const net = {};
    inRange.forEach((t) => {
      const f = {}, g = {};
      (t.from || []).forEach((r) => (f[codeOf(r.project)] = (f[codeOf(r.project)] || 0) + r.percent));
      (t.to || []).forEach((r) => (g[codeOf(r.project)] = (g[codeOf(r.project)] || 0) + r.percent));
      new Set([...Object.keys(f), ...Object.keys(g)]).forEach((k) => (net[k] = (net[k] || 0) + ((g[k] || 0) - (f[k] || 0)) / 100));
    });

    return {
      movers, moversPrev, repeat, multi, factsN: facts.length, avgProjects, focus, lastMo,
      compared, mismatched, mismatchList: mismatchList.sort((a, b) => b.diff - a.diff).slice(0, 5),
      temp, returns, decided, rejected, avgWait, pending, avgLead, retro, leadsN: leads.length,
      bench, corrected, personMonths, rangeEntries: rangeEntries.length, withHours: withHours.length, avgHours,
      filledNow, inTeams: inTeams.length, curKey,
      reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([label, value]) => ({ label, value })),
      net: Object.entries(net).filter(([, v]) => Math.abs(v) >= 0.005).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, value]) => ({ label, value })),
    };
  }, [inRange, inPrev, monthly, ids, employees, allocAt, live, today, from, to, fin, entries, months, people, teams, codes]);

  const headcount = people.length;
  const card = { background: C.surface, border: "1px solid " + C.line, borderRadius: 4, padding: 20, minWidth: 0 };
  const h2 = { margin: 0, fontFamily: SERIF, fontSize: 19, fontWeight: 600 };
  const tableBtn = (k) => (
    <button className="link" style={{ fontSize: 12.5, marginLeft: "auto" }} onClick={() => toggle(k)} aria-expanded={!!tables[k]}>
      {tables[k] ? "сховати таблицю" : "таблиця"}
    </button>
  );
  const lastFte = fte.rows.length ? Object.values(fte.rows[fte.rows.length - 1].values).reduce((a, b) => a + b, 0) : 0;
  const deltaMoves = inRange.length - inPrev.length;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <section style={{ ...card, padding: "14px 20px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ ...h2, fontSize: 21 }}>Дашборд</h2>
        <div role="group" aria-label="Період" style={{ display: "flex", marginLeft: 8 }}>
          {[3, 6, 12].map((n, i) => (
            <button key={n} onClick={() => setRange(n)} aria-pressed={range === n}
              style={{ cursor: "pointer", padding: "5px 12px", fontSize: 12.5, border: "1px solid " + (range === n ? C.ink2 : C.line),
                background: range === n ? C.ink : C.surface, color: range === n ? "#fff" : C.ink2, marginLeft: i ? -1 : 0,
                borderRadius: i === 0 ? "3px 0 0 3px" : i === 2 ? "0 3px 3px 0" : 0 }}>
              {n} міс
            </button>
          ))}
        </div>
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Команда" style={{ width: "auto" }}>
          <option value="all">Усі команди</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <span style={{ color: C.muted, fontSize: 12.5 }}>{fmt(from)}.{from.slice(0, 4)} — {fmt(to)}.{to.slice(0, 4)}</span>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        <Tile label="Людей" value={headcount.toLocaleString("uk-UA")} sub={teamId === "all" ? "у довіднику" : teamName(teamId)} />
        <Tile label="Ставок у табелі" value={nf1(lastFte)} sub={fte.rows.length ? "за " + fte.rows[fte.rows.length - 1].label.toLowerCase() : ""} />
        <Tile label="Переведень" value={inRange.length} delta={(deltaMoves > 0 ? "+" : deltaMoves < 0 ? "−" : "±") + Math.abs(deltaMoves) + " проти попередніх " + range + " міс"} />
        <Tile label="Внутрішня мобільність" value={share(hr.movers, headcount)} sub={hr.movers + " " + plural(hr.movers, "людина", "людини", "людей") + " змінили розподіл"} />
        <Tile label="Вчасне подання табеля" value={delays.rate == null ? "—" : delays.rate + "%"} sub="від усіх періодів із терміном, що минув" />
      </div>

      <section style={card}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
          <h2 style={h2}>Ставки по продуктах за місяцями</h2>
          {tableBtn("fte")}
        </div>
        <p style={{ margin: "0 0 12px", color: C.muted, fontSize: 12.5 }}>
          Сума відсотків табеля ÷ 100 (людина на 50% — 0,5 ставки), згруповано за кодом продукту. Місяць зводиться з двох половин
          так само, як у «Місяць · фін. облік»; закритий місяць — із зафіксованого знімка.
        </p>
        <Legend series={fte.series} />
        <StackedColumns months={fte.rows} series={fte.series} unit="ставок" emptyText="За цей період табель ще не заповнювали." />
        {tables.fte && (
          <DataTable head={["Місяць", ...fte.series.map((s) => s.key === "__other" ? "Інші" : s.key), "Разом"]}
            rows={fte.rows.map((r) => [r.label, ...fte.series.map((s) => (r.values[s.key] ? nf1(r.values[s.key]) : "—")), nf1(Object.values(r.values).reduce((a, b) => a + b, 0))])} />
        )}
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 20, alignItems: "start" }}>
        <section style={card}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
            <h2 style={h2}>Динаміка переведень</h2>
            {tableBtn("moves")}
          </div>
          <Legend series={moves.series} />
          <StackedColumns months={moves.rows} series={moves.series} unit="переведень" height={220} emptyText="За цей період переведень не було." />
          {tables.moves && (
            <DataTable head={["Місяць", "Постійні", "Тимчасові", "Разом"]}
              rows={moves.rows.map((r) => [r.label, r.values.perm, r.values.temp, r.values.perm + r.values.temp])} />
          )}
        </section>
        <section style={card}>
          <h2 style={{ ...h2, marginBottom: 4 }}>Рух ставок по продуктах</h2>
          <p style={{ margin: "0 0 14px", color: C.muted, fontSize: 12.5 }}>Нетто за переведеннями періоду: прийшло мінус пішло, у ставках.</p>
          {hr.net.length ? <DivergingList items={hr.net} /> : <p style={{ color: C.muted, margin: 0 }}>Переведень за період немає.</p>}
        </section>
      </div>

      <section style={card}>
        <h2 style={{ ...h2, marginBottom: 4 }}>Хто затримує подання табеля</h2>
        <p style={{ margin: "0 0 12px", color: C.muted, fontSize: 12.5 }}>
          Термін — 15-те число за першу половину і останній день місяця за другу. Спершу команди з простроченими періодами.
        </p>
        {delays.rows.length === 0 ? <p style={{ color: C.muted, margin: 0 }}>Команд із людьми ще немає.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th style={{ minWidth: 180 }}>Команда</th>
                  <th style={{ textAlign: "right" }}>Вчасно</th>
                  <th style={{ textAlign: "right", whiteSpace: "nowrap" }}>Сер. затримка</th>
                  <th style={{ textAlign: "right" }}>Прострочено</th>
                  {delays.periods.map((p) => <th key={p.key} style={{ whiteSpace: "nowrap" }}>{p.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {delays.rows.map((r) => (
                  <tr key={r.id}>
                    <td><div style={{ fontWeight: 600 }}>{r.name}</div><div style={{ color: C.muted, fontSize: 11.5 }}>{r.owner}</div></td>
                    <td className="num" style={{ textAlign: "right", fontWeight: 600 }}>{r.rate == null ? "—" : r.rate + "%"}</td>
                    <td className="num" style={{ textAlign: "right" }}>{r.avgLate ? nf1(r.avgLate) + " дн" : "—"}</td>
                    <td className="num" style={{ textAlign: "right", fontWeight: r.overdue ? 600 : 400 }}>{r.overdue || "—"}</td>
                    {delays.periods.map((p) => (
                      <td key={p.key} title={r.cells[p.key].title}><StatusChip kind={r.cells[p.key].kind} text={r.cells[p.key].text} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 20, alignItems: "start" }}>
        <section style={card}>
          <h2 style={{ ...h2, marginBottom: 4 }}>HR-метрики</h2>
          <p style={{ margin: "0 0 4px", color: C.muted, fontSize: 12.5 }}>
            За обраний період{hr.lastMo ? "; табельні — за " + hr.lastMo.label.toLowerCase() : ""}.
          </p>
          <Metric title="Внутрішня мобільність" value={share(hr.movers, headcount)}
            detail={hr.movers + " з " + headcount + " змінили розподіл; попередній такий самий період — " + share(hr.moversPrev, headcount) + "."}
            why="Частка людей, яких хоч раз переводили. Здорова мобільність — розвиток; дуже висока — ознака нестабільних планів." />
          <Metric title="Повторні переведення" value={hr.repeat}
            detail={hr.repeat ? hr.repeat + " " + plural(hr.repeat, "людина мала", "людини мали", "людей мали") + " два й більше переведень." : "Нікого не переводили двічі."}
            why="Часті переїзди однієї людини знижують продуктивність і залученість." />
          <Metric title="Робота на кількох проєктах" value={share(hr.multi, hr.factsN)}
            detail={"У середньому " + nf1(hr.avgProjects) + " " + plural(Math.round(hr.avgProjects), "проєкт", "проєкти", "проєктів") + " на людину."}
            why="Висока фрагментація — ризик перемикання контексту й вигорання." />
          <Metric title="Фокус на основному проєкті" value={hr.factsN ? Math.round(hr.focus * 100) + "%" : "—"}
            detail="Середня частка найбільшого проєкту в розподілі людини." />
          <Metric title="План проти факту" value={share(hr.mismatched, hr.compared)}
            detail={hr.compared
              ? hr.mismatched + " з " + hr.compared + " мають табель, що відрізняється від розподілу за переведеннями на 20 п.п. і більше."
              : "Немає людей, для яких є і переведення, і табель."}
            why="Розбіжність означає неоформлені переведення або помилки в табелі." />
          {hr.mismatchList.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "-4px 0 10px" }}>
              {hr.mismatchList.map((x) => (
                <button key={x.id} className="link" style={{ fontSize: 12.5 }} onClick={() => onOpenPerson(x.id)}>{x.name} ({x.diff} п.п.)</button>
              ))}
            </div>
          )}
        </section>

        <section style={card}>
          <Metric title="Тимчасові переведення" value={share(hr.temp, inRange.length)}
            detail={"Повернень у найближчі 30 днів: " + hr.returns + "."} />
          <Metric title="Погодження PM" value={hr.avgWait == null ? "—" : nf1(hr.avgWait) + " дн"}
            detail={"Середній час до рішення. Заперечено " + share(hr.rejected, hr.decided) + " рішень; зараз чекають " + hr.pending + "."} />
          <Metric title="Горизонт планування" value={hr.avgLead == null ? "—" : Math.round(hr.avgLead) + " дн"}
            detail={"Від створення запису до дати переведення. Заднім числом: " + share(hr.retro, hr.leadsN) + "."}
            why="Переведення заднім числом ускладнюють фін. облік і погодження." />
          <Metric title="Бенч" value={nf1(hr.bench) + " ст."}
            detail="Ставки на проєктах, у назві яких є «бенч» або «bench», за останній місяць табеля." />
          <Metric title="Ручні коригування фін. обліку" value={share(hr.corrected, hr.personMonths)}
            detail={hr.corrected + " " + plural(hr.corrected, "коригування", "коригування", "коригувань") + " на " + hr.personMonths + " людино-місяців."}
            why="Багато коригувань — табель погано відображає реальність." />
          <Metric title="Облік у годинах" value={share(hr.withHours, hr.rangeEntries)}
            detail={hr.avgHours == null ? "Години ще не вносили." : "У середньому " + nf1(hr.avgHours) + " год на людину за пів місяця."} />
          <Metric title="Заповненість поточного табеля" value={share(hr.filledNow, hr.inTeams)}
            detail={hr.filledNow + " з " + hr.inTeams + " людей у командах мають відсотки за поточну половину місяця."} />
        </section>
      </div>

      <section style={card}>
        <h2 style={{ ...h2, marginBottom: 14 }}>Підстави переведень</h2>
        {hr.reasons.length ? <BarList items={hr.reasons} /> : <p style={{ color: C.muted, margin: 0 }}>Переведень за період немає.</p>}
      </section>
    </div>
  );
}
