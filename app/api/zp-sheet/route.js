import { NextResponse } from "next/server";
import { whoIs } from "../../../lib/auth";

export const dynamic = "force-dynamic";

/* Теги в Google Таблицю.
   Додаток шле сюди обрані рядки, а звідси вони йдуть у скрипт таблиці (Apps Script),
   який вписує відсотки в аркуш «Фіксовані теги». Ключ живе лише на сервері.
   Потрібні змінні середовища: ZP_SHEET_URL (адреса веб-застосунку Apps Script)
   і ZP_SHEET_SECRET (той самий рядок, що й у скрипті).
   GET  — чи все налаштовано (для кнопки в інтерфейсі).
   POST { rows: [{ name, tag, status, pct: { cbx: 60, … } }] } — оновити рядки. */

const urlOf = () => (process.env.ZP_SHEET_URL || "").trim();
const secretOf = () => (process.env.ZP_SHEET_SECRET || "").trim();
const ready = () => /^https:\/\/script\.google\.com\//.test(urlOf()) && secretOf().length >= 16;

async function admin(request) {
  const me = await whoIs(request);
  if (me.error) return { res: NextResponse.json({ error: me.error }, { status: 401 }) };
  if (!me.isAdmin) return { res: NextResponse.json({ error: "Надсилати теги в таблицю може лише адміністратор." }, { status: 403 }) };
  return { me };
}

export async function GET(request) {
  const gate = await admin(request);
  if (gate.res) return gate.res;
  return NextResponse.json({ ready: ready() });
}

export async function POST(request) {
  const gate = await admin(request);
  if (gate.res) return gate.res;
  if (!ready()) {
    return NextResponse.json({ error: "Не налаштовано: задайте ZP_SHEET_URL і ZP_SHEET_SECRET у змінних середовища." }, { status: 400 });
  }
  const body = await request.json().catch(() => ({}));
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return NextResponse.json({ error: "Немає рядків для надсилання." }, { status: 400 });
  if (rows.length > 500) return NextResponse.json({ error: "Забагато рядків за раз — не більше 500." }, { status: 400 });

  const clean = rows.slice(0, 500).map((r) => ({
    name: String(r.name || "").slice(0, 120),
    tag: String(r.tag || "").slice(0, 200),
    status: String(r.status || "").slice(0, 120),
    pct: Object.fromEntries(Object.entries(r.pct || {}).slice(0, 40)
      .map(([k, v]) => [String(k).slice(0, 20), Math.max(0, Math.min(100, Number(v) || 0))])),
  })).filter((r) => r.name);

  const payload = { key: secretOf(), by: gate.me.name || "", at: new Date().toISOString(), rows: clean };
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    res = await fetch(urlOf(), {
      method: "POST", redirect: "follow", signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    clearTimeout(timer);
  } catch (e) {
    return NextResponse.json({ error: "Таблиця не відповіла: " + (e && e.name === "AbortError" ? "надто довго" : "немає зв'язку") }, { status: 502 });
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* скрипт віддав не JSON */ }
  if (!res.ok || !data) {
    return NextResponse.json({ error: "Скрипт таблиці відповів помилкою (HTTP " + res.status + "). Перевірте адресу й доступ «Будь-хто з посиланням»." }, { status: 502 });
  }
  if (data.error) return NextResponse.json({ error: String(data.error).slice(0, 300) }, { status: 400 });
  return NextResponse.json({
    updated: Number(data.updated) || 0,
    added: Number(data.added) || 0,
    problems: Array.isArray(data.problems) ? data.problems.slice(0, 50) : [],
    sheet: data.sheet || "",
  });
}
