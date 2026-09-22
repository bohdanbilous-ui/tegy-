import { NextResponse } from "next/server";
import crypto from "crypto";
import { readState, readKey, writeKey } from "../../../lib/store";
import { whoIs } from "../../../lib/auth";
import { KEY, normalize, kyivNow, periodOfDate, shiftPeriod, periodLabel, periodStatus, buildTargets, autoPeriodFor, DEFAULT_TEMPLATE } from "../../../lib/reminders";

export const dynamic = "force-dynamic";

/* Нагадування про табель.
   Адміністратор (Bearer): GET — налаштування, стан періоду, історія; PUT — текст, Slack ID, автонагадування;
     POST { periodKey, names } — поставити надсилання в чергу.
   Заплановане завдання (x-reminder-key = REMINDER_SECRET): GET ?pending=1 — що надіслати зараз
     (черга + автонагадування, якщо сьогодні його день); POST { jobId, results } — що надіслано. */

const URL_APP = process.env.APP_URL || "https://tegy-rho.vercel.app";
const RE_SLACK = /^[UW][A-Z0-9]{6,15}$/;
const nowISO = () => new Date().toISOString();

function keyOk(request) {
  const secret = process.env.REMINDER_SECRET || "";
  if (secret.length < 16) return false;
  const a = crypto.createHash("sha256").update(request.headers.get("x-reminder-key") || "").digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}
async function admin(request) {
  const me = await whoIs(request);
  if (me.error) return { res: NextResponse.json({ error: me.error }, { status: 401 }) };
  if (!me.isAdmin) return { res: NextResponse.json({ error: "Нагадування налаштовує лише адміністратор." }, { status: 403 }) };
  return { me };
}
const load = async () => normalize(await readKey(KEY));
const view = (cfg, state, key) => ({
  template: cfg.template, defaultTemplate: DEFAULT_TEMPLATE, slack: cfg.slack, auto: cfg.auto,
  periodKey: key, periodLabel: periodLabel(key), status: periodStatus(state, key),
  targets: buildTargets(cfg, state, key, URL_APP),
  jobs: cfg.jobs.slice(-30).reverse(), keyReady: (process.env.REMINDER_SECRET || "").length >= 16,
  updatedAt: cfg.updatedAt, updatedBy: cfg.updatedBy,
});
const validKey = (k) => /^\d{4}-\d{2}-H[12]$/.test(String(k || ""));

export async function GET(request) {
  if (request.headers.get("x-reminder-key")) {
    if (!keyOk(request)) return NextResponse.json({ error: "Невірний ключ нагадувань." }, { status: 403 });
    const cfg = await load();
    const state = (await readState()) || {};
    const now = kyivNow();
    const stamp = nowISO();
    // Автонагадування: у його день, з 10:00 за Києвом, один раз на період.
    const autoKey = autoPeriodFor(now.date);
    if (cfg.auto && autoKey && now.hour >= 10 && !cfg.autoSent[autoKey] && !cfg.jobs.some((j) => j.auto && j.periodKey === autoKey)) {
      cfg.jobs.push({ id: "rj_" + crypto.randomBytes(6).toString("hex"), auto: true, periodKey: autoKey, by: "автоматично", at: stamp, status: "queued",
        targets: buildTargets(cfg, state, autoKey, URL_APP) });
      cfg.autoSent[autoKey] = stamp;
    }
    // Видаємо чергу; «забране», але не підтверджене за 50 хв, видаємо знову.
    const stale = Date.now() - 50 * 60 * 1000;
    const out = [];
    cfg.jobs.forEach((j) => {
      if (j.status === "queued" || (j.status === "claimed" && Date.parse(j.claimedAt) < stale)) {
        j.status = "claimed"; j.claimedAt = stamp;
        out.push({ jobId: j.id, periodLabel: periodLabel(j.periodKey), messages: j.targets.filter((t) => t.slackId).map((t) => ({ name: t.name, slackId: t.slackId, text: t.text })),
          skipped: j.targets.filter((t) => !t.slackId).map((t) => t.name) });
      }
    });
    await writeKey(KEY, cfg);
    return NextResponse.json({ jobs: out, today: now.date });
  }
  const g = await admin(request);
  if (g.res) return g.res;
  const u = new URL(request.url);
  const today = periodOfDate(kyivNow().date);
  const key = validKey(u.searchParams.get("period")) ? u.searchParams.get("period") : today;
  return NextResponse.json({ ...view(await load(), (await readState()) || {}, key), current: today, previous: shiftPeriod(today, -1) });
}

export async function PUT(request) {
  const g = await admin(request);
  if (g.res) return g.res;
  let body; try { body = await request.json(); } catch (e) { return NextResponse.json({ error: "Некоректний запит." }, { status: 400 }); }
  const cfg = await load();
  if (typeof body?.template === "string") {
    const t = body.template.replace(/\r/g, "").slice(0, 3000);
    if (!t.trim()) return NextResponse.json({ error: "Текст не може бути порожнім." }, { status: 400 });
    cfg.template = t;
  }
  if (body?.slack && typeof body.slack === "object") {
    const next = {};
    for (const [name, id] of Object.entries(body.slack)) {
      const n = String(name).trim().slice(0, 120), v = String(id || "").trim().toUpperCase();
      if (!n) continue;
      if (v && !RE_SLACK.test(v)) return NextResponse.json({ error: "Slack ID для «" + n + "» має вигляд U0123ABCD." }, { status: 400 });
      next[n] = v;
    }
    cfg.slack = next;
  }
  if (typeof body?.auto === "boolean") cfg.auto = body.auto;
  cfg.updatedAt = nowISO(); cfg.updatedBy = g.me.name;
  await writeKey(KEY, cfg);
  const key = validKey(body?.periodKey) ? body.periodKey : periodOfDate(kyivNow().date);
  return NextResponse.json(view(cfg, (await readState()) || {}, key));
}

export async function POST(request) {
  let body; try { body = await request.json(); } catch (e) { return NextResponse.json({ error: "Некоректний запит." }, { status: 400 }); }
  // Звіт запланованого завдання про надсилання.
  if (request.headers.get("x-reminder-key")) {
    if (!keyOk(request)) return NextResponse.json({ error: "Невірний ключ нагадувань." }, { status: 403 });
    const cfg = await load();
    const j = cfg.jobs.find((x) => x.id === body?.jobId);
    if (!j) return NextResponse.json({ error: "Немає такого надсилання." }, { status: 404 });
    j.status = "sent"; j.sentAt = nowISO();
    j.results = (Array.isArray(body?.results) ? body.results : []).slice(0, 50)
      .map((r) => ({ name: String(r?.name || "").slice(0, 120), ok: !!r?.ok, error: String(r?.error || "").slice(0, 200) }));
    await writeKey(KEY, cfg);
    return NextResponse.json({ ok: true });
  }
  const g = await admin(request);
  if (g.res) return g.res;
  if (!validKey(body?.periodKey)) return NextResponse.json({ error: "Некоректний період." }, { status: 400 });
  const cfg = await load();
  if (cfg.jobs.some((j) => j.status !== "sent" && j.periodKey === body.periodKey && !j.auto && Date.now() - Date.parse(j.at) < 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Надсилання за цей період уже в черзі." }, { status: 409 });
  }
  const names = Array.isArray(body?.names) ? body.names.map(String) : null;
  const targets = buildTargets(cfg, (await readState()) || {}, body.periodKey, URL_APP, names);
  if (!targets.length) return NextResponse.json({ error: "Нікому надсилати: усі команди подали період або нікого не вибрано." }, { status: 400 });
  cfg.jobs.push({ id: "rj_" + crypto.randomBytes(6).toString("hex"), auto: false, periodKey: body.periodKey, by: g.me.name, at: nowISO(), status: "queued", targets });
  cfg.jobs = cfg.jobs.slice(-60);
  await writeKey(KEY, cfg);
  return NextResponse.json(view(cfg, (await readState()) || {}, body.periodKey));
}
