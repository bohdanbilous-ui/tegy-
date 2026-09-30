import { NextResponse } from "next/server";
import { whoIs } from "../../../lib/auth";
import { readInn, innFor, maskInn, setManualInn } from "../../../lib/pay";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* Відомості ЗП — адміністратор і бухгалтер.
   GET                        — чи налаштовано Google Таблицю і в кого є ІПН (лише останні 4 символи).
   GET ?id=…                  — повний ІПН однієї людини (кнопка «показати»).
   POST { action: "inn" }     — задати / прибрати ІПН вручну: { items: [{ id, inn }] } (inn "" — прибрати).
   POST { action: "send" }    — записати відомості в Google Таблицю:
        { period, tabs: [{ name, header: [...], rows: [{ id, cells: [...] }] }] }
        У клітинку зі значенням "{{ІПН}}" сервер сам підставляє ІПН людини з id рядка —
        повні ІПН у браузер не потрапляють.
   Змінні середовища: PAY_SHEET_URL — адреса веб-застосунку Apps Script таблиці відомостей;
   PAY_SHEET_SECRET — ключ (якщо не задано, береться ZP_SHEET_SECRET). */

const urlOf = () => (process.env.PAY_SHEET_URL || "").trim();
const secretOf = () => (process.env.PAY_SHEET_SECRET || process.env.ZP_SHEET_SECRET || "").trim();
const ready = () => /^https:\/\/script\.google\.com\//.test(urlOf()) && secretOf().length >= 16;
const INN_MARK = "{{ІПН}}";

async function admin(request) {
  const me = await whoIs(request);
  if (me.error) return { res: NextResponse.json({ error: me.error }, { status: 401 }) };
  if (me.role !== "admin" && me.role !== "accountant") return { res: NextResponse.json({ error: "Відомості ЗП доступні адміністратору й бухгалтеру." }, { status: 403 }) };
  return { me };
}

export async function GET(request) {
  const g = await admin(request);
  if (g.res) return g.res;
  const id = new URL(request.url).searchParams.get("id");
  if (id) return NextResponse.json({ id, inn: innFor(await readInn(), id) });
  return NextResponse.json({ ready: ready(), inn: maskInn(await readInn()) });
}

const cell = (v) => (typeof v === "number" && Number.isFinite(v) ? v : String(v == null ? "" : v).slice(0, 1000));
const tabName = (s) => String(s || "Відомість").replace(/[\[\]*?\/\\:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "Відомість";

export async function POST(request) {
  const g = await admin(request);
  if (g.res) return g.res;
  const body = await request.json().catch(() => ({}));

  if (body.action === "inn") {
    const items = Array.isArray(body.items) ? body.items.slice(0, 2000) : [];
    const r = await setManualInn(items);
    return NextResponse.json({ ...r, inn: maskInn(await readInn()) });
  }

  if (body.action !== "send") return NextResponse.json({ error: "Невідома дія." }, { status: 400 });
  if (!ready()) {
    return NextResponse.json({ error: "Не налаштовано: задайте PAY_SHEET_URL (і PAY_SHEET_SECRET або ZP_SHEET_SECRET) у змінних Vercel." }, { status: 400 });
  }
  const tabs = (Array.isArray(body.tabs) ? body.tabs : []).slice(0, 40);
  if (!tabs.length) return NextResponse.json({ error: "Немає відомостей для надсилання." }, { status: 400 });

  const store = await readInn();
  let noInn = 0;
  const clean = tabs.map((t) => ({
    name: tabName(t.name),
    rows: [
      (Array.isArray(t.header) ? t.header : []).slice(0, 30).map(cell),
      ...(Array.isArray(t.rows) ? t.rows : []).slice(0, 2000).map((r) => (Array.isArray(r.cells) ? r.cells : []).slice(0, 30).map((v) => {
        if (v !== INN_MARK) return cell(v);
        const inn = innFor(store, String(r.id || ""));
        if (!inn) noInn++;
        return inn;
      })),
    ],
  }));

  const payload = { key: secretOf(), by: g.me.name || "", at: new Date().toISOString(), period: String(body.period || "").slice(0, 120), tabs: clean };
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 50000);
    res = await fetch(urlOf(), { method: "POST", redirect: "follow", signal: ctrl.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    clearTimeout(timer);
  } catch (e) {
    return NextResponse.json({ error: "Таблиця не відповіла: " + (e && e.name === "AbortError" ? "надто довго" : "немає зв'язку") }, { status: 502 });
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* не JSON */ }
  if (!res.ok || !data) {
    return NextResponse.json({ error: "Скрипт таблиці відповів помилкою (HTTP " + res.status + "). Перевірте адресу й доступ «Будь-хто»." }, { status: 502 });
  }
  if (data.error) return NextResponse.json({ error: String(data.error).slice(0, 300) }, { status: 400 });
  return NextResponse.json({ ok: true, tabs: Number(data.tabs) || clean.length, rows: Number(data.rows) || 0, noInn, url: String(data.url || "").slice(0, 300) });
}
