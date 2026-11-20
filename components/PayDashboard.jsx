"use client";
/* Панель готовності ЗП — головний екран фінансового менеджера.
   Показує, чи готові відомості за період, що саме заважає (з іменами), що ще лишилось до
   вивантаження і чи свіжі дані співробітників. Дані — ті самі рядки, що й у «Відомостях ЗП». */
import React from "react";

const C = {
  paper: "#F5F7FB", surface: "#FFFFFF", ink: "#0F172A", ink2: "#334155", muted: "#64748B",
  line: "#DDE3EC", lineSoft: "#EEF2F6", signal: "#2563EB", signalSoft: "#EFF6FF",
  ok: "#15803D", okSoft: "#F0FDF4", okLine: "#BBF7D0", warn: "#B45309", warnSoft: "#FFF7ED", warnLine: "#FED7AA",
  stop: "#B91C1C", stopSoft: "#FEF2F2",
};
const card = { background: C.surface, border: "1px solid " + C.line, borderRadius: 12, boxShadow: "0 1px 2px rgba(15,23,42,.04)" };
const MONTHS = ["Січень","Лютий","Березень","Квітень","Травень","Червень","Липень","Серпень","Вересень","Жовтень","Листопад","Грудень"];
const plural = (n, a, b, c) => { const m = n % 100; if (m > 10 && m < 20) return c; const k = n % 10; return k === 1 ? a : k > 1 && k < 5 ? b : c; };
const ago = (iso) => {
  const t = Date.parse(iso); if (isNaN(t)) return "";
  const h = Math.floor((Date.now() - t) / 3600000);
  if (h < 1) return "щойно";
  if (h < 24) return h + " " + plural(h, "годину", "години", "годин") + " тому";
  const d = Math.floor(h / 24); return d + " " + plural(d, "день", "дні", "днів") + " тому";
};
const fmtAt = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, "0"); return isNaN(d) ? "" : p(d.getDate()) + "." + p(d.getMonth() + 1) + " " + p(d.getHours()) + ":" + p(d.getMinutes()); };

function Dot({ state }) {
  const bg = state === "ok" ? C.ok : state === "warn" ? C.warn : state === "off" ? C.line : C.stop;
  const ch = state === "ok" ? "✓" : state === "off" ? "–" : "!";
  return <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 11, background: bg, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flex: "none" }}>{ch}</span>;
}

export default function PayDashboard({ per, setPer, lastDay, included, issues, statements, approval, stale, canEdit, reconLoaded, reconOpen, reconUnmatched,
  lastSend, perKey, pfInfo, onSync, syncBusy, isAdmin, onGo, halfText }) {
  const total = included.length;
  const bad = included.filter((r) => r.problems.length).length;
  const ready = total - bad;
  const pct = total ? Math.round((ready / total) * 100) : 0;
  const count = (...keys) => issues.filter((x) => keys.includes(x.k)).reduce((s, x) => s + x.rows.length, 0);
  const firstOf = (...keys) => (issues.find((x) => keys.includes(x.k)) || {}).k || "";
  const label = MONTHS[per.m - 1] + " " + per.y + " · " + halfText;
  const last = pfInfo && pfInfo.last;
  const syncAge = last && last.at ? (Date.now() - Date.parse(last.at)) / 3600000 : null;
  const syncState = !isAdmin ? "off" : !last ? "warn" : !last.ok ? "bad" : syncAge > 36 ? "warn" : "ok";

  const steps = [
    ...(isAdmin ? [{ k: "sync", state: syncState, title: "Дані співробітників оновлено",
      text: !last ? "Синхронізацію ще не запускали." : !last.ok ? "Остання синхронізація не вдалась: " + (last.error || "помилка") : "Остання — " + ago(last.at) + " (" + fmtAt(last.at) + "), у таблиці " + (last.total || 0) + " людей.",
      act: onSync ? { label: syncBusy ? "Синхронізую…" : "Синхронізувати зараз", run: onSync, disabled: syncBusy } : null }] : []),
    { k: "inn", state: count("inn", "innbad", "inndup") ? "bad" : "ok", title: "ІПН задано, коректні й без повторів",
      text: count("inn", "innbad", "inndup") ? "Без ІПН: " + count("inn") + " · некоректних: " + count("innbad") + " · повторів: " + count("inndup") : "Усе гаразд.",
      act: count("inn", "innbad", "inndup") ? { label: "Виправити", run: () => onGo("issue:" + firstOf("inndup", "innbad", "inn")) } : null },
    { k: "legal", state: count("legal", "type") ? "bad" : "ok", title: "Юрособа і тип Штат/Гіг у кожного",
      text: count("legal", "type") ? "Без юрособи: " + count("legal") + " · без типу: " + count("type") : "Усе гаразд.",
      act: count("legal", "type") ? { label: "Виправити", run: () => onGo("issue:" + firstOf("type", "legal")) } : null },
    { k: "alloc", state: count("alloc") ? "bad" : "ok", title: "Розподіл і коди проєктів",
      text: count("alloc") ? "Рядків із проблемою розподілу: " + count("alloc") : "Усе гаразд.",
      act: count("alloc") ? { label: "Виправити", run: () => onGo("issue:alloc") } : null },
    { k: "fio", state: count("fio") ? "warn" : "ok", title: "ПІБ повністю (з по батькові)",
      text: count("fio") ? "Неповних ПІБ: " + count("fio") : "Усе гаразд.",
      act: count("fio") ? { label: "Показати", run: () => onGo("issue:fio") } : null },
    { k: "recon", state: !reconLoaded ? "off" : reconOpen.length || reconUnmatched ? "warn" : "ok", title: "Звірка PM",
      text: !reconLoaded ? "За цей період годин із трекерів немає." : reconOpen.length ? "Чекаємо підтвердження: " + reconOpen.map((x) => x.project).join(", ") : reconUnmatched ? "Годин без відповідності в Allocate: " + reconUnmatched : "Підтверджено по всіх проєктах." },
    { k: "approve", state: approval ? (stale ? "warn" : "ok") : "off", title: "Відомості затверджено",
      text: approval ? (stale ? "Затверджено, але дані далі змінились — затвердьте знову. " : "") + approval.by + ", " + fmtAt(approval.at) : bad ? "Спершу виправте проблеми." : "Готово до затвердження.",
      act: !approval || stale ? (canEdit && !bad ? { label: "До відомостей", run: () => onGo("all") } : null) : null },
    { k: "send", state: lastSend ? "ok" : "off", title: "Вивантажено в Google Таблицю",
      text: lastSend ? fmtAt(lastSend.at) + " · " + lastSend.by + " · " + lastSend.count + " " + plural(lastSend.count, "людина", "людини", "людей") + (lastSend.bad ? ", з проблемами: " + lastSend.bad : "") : "За цей період ще не вивантажували." },
  ];
  const open = steps.filter((s) => s.state === "bad" || s.state === "warn").length;

  const btn = { cursor: "pointer", padding: "6px 12px", borderRadius: 8, border: "1px solid " + C.line, background: C.surface, color: C.ink2, fontWeight: 500, fontSize: 12.5 };
  const kpi = (title, value, sub, tone) => (
    <div style={{ ...card, padding: "14px 18px", minWidth: 150, flex: "1 1 150px" }}>
      <div style={{ fontSize: 12, color: C.muted }}>{title}</div>
      <div className="num" style={{ fontSize: 26, fontWeight: 700, color: tone || C.ink, letterSpacing: "-0.02em", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <section style={{ ...card, padding: "18px 22px" }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, color: C.muted }}>Панель готовності ЗП</div>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" }}>{label}</div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: "auto", flexWrap: "wrap" }}>
            <button style={btn} aria-label="Попередній місяць" onClick={() => setPer((p) => { const i = p.y * 12 + p.m - 2; return { ...p, y: Math.floor(i / 12), m: (i % 12) + 1 }; })}>←</button>
            <button style={btn} aria-label="Наступний місяць" onClick={() => setPer((p) => { const i = p.y * 12 + p.m; return { ...p, y: Math.floor(i / 12), m: (i % 12) + 1 }; })}>→</button>
            <select value={per.half} onChange={(e) => setPer((p) => ({ ...p, half: +e.target.value }))} aria-label="Половина місяця" style={{ width: "auto" }}>
              <option value={1}>01–15</option>
              <option value={2}>16–{lastDay(per.y, per.m)}</option>
            </select>
            <button style={{ ...btn, background: C.signalSoft, color: C.signal, borderColor: "#BFDBFE" }} onClick={() => onGo("all")}>До відомостей →</button>
          </div>
        </div>

        <div style={{ marginTop: 18, display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 320px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
              <span style={{ fontWeight: 600, color: bad ? C.warn : C.ok }}>
                {!total ? "Немає кого вивантажувати" : bad ? "Не готово: " + bad + " з " + total + " " + plural(total, "рядка", "рядків", "рядків") : "Усе готово до вивантаження"}
              </span>
              <span className="num" style={{ color: C.muted }}>{pct}%</span>
            </div>
            <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Готовність відомостей"
              style={{ height: 10, background: C.lineSoft, borderRadius: 6, overflow: "hidden" }}>
              <div style={{ width: pct + "%", height: "100%", background: bad ? "#F59E0B" : "#22C55E", borderRadius: 6, transition: "width .3s" }} />
            </div>
          </div>
        </div>
      </section>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {kpi("У відомостях", total, statements.length + " " + plural(statements.length, "відомість", "відомості", "відомостей"))}
        {kpi("Готово", ready, pct + "% рядків", total && !bad ? C.ok : C.ink)}
        {kpi("Потребує уваги", bad, bad ? issues.length + " " + plural(issues.length, "тип проблеми", "типи проблем", "типів проблем") : "проблем немає", bad ? C.warn : C.ok)}
        {kpi("Кроків відкрито", open, open ? "див. чек-ліст нижче" : "усе пройдено", open ? C.warn : C.ok)}
      </div>

      <section style={{ ...card, padding: "16px 22px" }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Перед вивантаженням</div>
        <div style={{ display: "grid", gap: 2 }}>
          {steps.map((s) => (
            <div key={s.k} style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 0", borderTop: "1px solid " + C.lineSoft }}>
              <Dot state={s.state} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{s.title}</div>
                <div style={{ fontSize: 12.5, color: s.state === "bad" ? C.stop : s.state === "warn" ? C.warn : C.muted }}>{s.text}</div>
              </div>
              {s.act && <button style={btn} disabled={s.act.disabled} onClick={s.act.run}>{s.act.label}</button>}
            </div>
          ))}
        </div>
      </section>

      {issues.length > 0 && (
        <section>
          <div style={{ fontWeight: 600, margin: "0 0 10px" }}>Що заважає</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 14 }}>
            {[...issues].sort((a, b) => b.rows.length - a.rows.length).map((x) => (
              <div key={x.k} style={{ ...card, padding: "14px 18px", borderColor: C.warnLine }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span className="num" style={{ fontSize: 24, fontWeight: 700, color: C.warn }}>{x.rows.length}</span>
                  <span style={{ fontWeight: 600 }}>{x.l}</span>
                </div>
                <ul style={{ margin: "8px 0 10px", padding: 0, listStyle: "none", fontSize: 12.5, color: C.ink2, display: "grid", gap: 3 }}>
                  {x.rows.slice(0, 5).map((r) => <li key={r.id} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</li>)}
                  {x.rows.length > 5 && <li style={{ color: C.muted }}>і ще {x.rows.length - 5}</li>}
                </ul>
                <button style={btn} onClick={() => onGo("issue:" + x.k)}>Виправити →</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section style={{ ...card, padding: "16px 22px" }}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Відомості за юрособами</div>
        {!statements.length ? <div style={{ color: C.muted, fontSize: 13 }}>Немає рядків.</div> : (
          <div style={{ display: "grid", gap: 0 }}>
            {statements.map((s) => {
              const p = s.rows.length ? Math.round(((s.rows.length - s.bad) / s.rows.length) * 100) : 0;
              return (
                <button key={s.key} onClick={() => onGo(s.key)} title="Відкрити цю відомість"
                  style={{ display: "grid", gridTemplateColumns: "minmax(160px,2fr) 70px 90px minmax(100px,1.2fr)", gap: 12, alignItems: "center", textAlign: "left",
                    background: "none", border: "none", borderTop: "1px solid " + C.lineSoft, padding: "10px 0", cursor: "pointer", font: "inherit", color: "inherit" }}>
                  <span style={{ fontWeight: 500 }}>{s.key}</span>
                  <span className="num" style={{ color: C.muted }}>{s.rows.length} {plural(s.rows.length, "особа", "особи", "осіб")}</span>
                  <span style={{ color: s.bad ? C.warn : C.ok, fontWeight: 600, fontSize: 12.5 }}>{s.bad ? "не готово " + s.bad : "готово"}</span>
                  <span style={{ height: 6, background: C.lineSoft, borderRadius: 4, overflow: "hidden" }}>
                    <span style={{ display: "block", width: p + "%", height: "100%", background: s.bad ? "#F59E0B" : "#22C55E" }} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
