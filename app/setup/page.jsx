"use client";
import React, { useEffect, useState } from "react";

/* Одноразова сторінка: створює перші облікові записи й показує паролі.
Відкривається за адресою /setup. Після створення більше не працює. */
export default function Setup() {
  const [status, setStatus] = useState(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [users, setUsers] = useState(null);

  useEffect(() => {
    fetch("/api/setup", { cache: "no-store" }).then((r) => r.json()).then(setStatus).catch(() => setStatus({ done: false, configured: false }));
  }, []);

  async function run() {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setupToken: code }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error || "Помилка " + res.status);
      else setUsers(data.users);
    } finally { setBusy(false); }
  }

  const box = { fontFamily: 'ui-sans-serif,-apple-system,"Segoe UI",Roboto,Arial,sans-serif', maxWidth: 760, margin: "40px auto", padding: 24, background: "#fff", border: "1px solid #C2CDE1", borderRadius: 4, color: "#141E38" };
  const cell = { borderBottom: "1px solid #DFE5F0", padding: "8px 10px", textAlign: "left" };

  return (
    <div style={{ background: "#E7ECF4", minHeight: "100vh", padding: 16 }}>
      <div style={box}>
        <h1 style={{ marginTop: 0, fontSize: 22 }}>Перше налаштування доступу</h1>
        {!status && <p>Перевіряємо…</p>}
        {status && status.done && !users && (
          <p>Облікові записи вже створені. Увійдіть на <a href="/">головній сторінці</a> і керуйте людьми в «Довідник → Користувачі».</p>
        )}
        {status && !status.done && !status.configured && (
          <p style={{ color: "#8A5510" }}>
            Спершу додайте у Vercel → Settings → Environment Variables змінну <b>SETUP_TOKEN</b> (будь-який довгий випадковий рядок, від 16 символів) і зробіть Redeploy.
          </p>
        )}
        {status && !status.done && status.configured && !users && (
          <>
            <p>Буде створено 8 облікових записів (2 адміністратори й 6 відповідальних). Паролі покажемо один раз — одразу збережіть їх.</p>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6F7B99", marginBottom: 6 }} htmlFor="code">Код SETUP_TOKEN з Vercel</label>
            <input id="code" type="password" value={code} onChange={(e) => setCode(e.target.value)}
              style={{ width: "100%", padding: "9px 10px", border: "1px solid #C2CDE1", borderRadius: 3, boxSizing: "border-box" }} />
            {error && <p role="alert" style={{ color: "#8A2E44" }}>{error}</p>}
            <button onClick={run} disabled={busy || !code}
              style={{ marginTop: 14, background: "#0C7480", color: "#fff", border: "none", borderRadius: 3, padding: "11px 18px", fontWeight: 600, cursor: "pointer", opacity: busy || !code ? 0.6 : 1 }}>
              {busy ? "Створюємо…" : "Створити облікові записи"}
            </button>
          </>
        )}
        {users && (
          <>
            <p style={{ background: "#F8EBD6", border: "1px solid #E6CFA6", borderRadius: 3, padding: "10px 12px", color: "#8A5510" }}>
              Збережіть цю таблицю зараз — після оновлення сторінки паролі вже не побачити (лише скинути в «Довідник → Користувачі»).
              Передайте кожному його логін і пароль особисто. Після цього приберіть SETUP_TOKEN з Vercel.
            </p>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
              <thead><tr><th style={cell}>Ім'я</th><th style={cell}>Роль</th><th style={cell}>Логін</th><th style={cell}>Пароль</th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.username}>
                    <td style={cell}>{u.displayName}</td>
                    <td style={cell}>{u.role === "admin" ? "адміністратор" : u.role === "hrd" ? "HRD" : "відповідальний"}</td>
                    <td style={{ ...cell, fontFamily: "monospace" }}>{u.username}</td>
                    <td style={{ ...cell, fontFamily: "monospace", userSelect: "all" }}>{u.password}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p><a href="/">Перейти до входу →</a></p>
          </>
        )}
      </div>
    </div>
  );
}
