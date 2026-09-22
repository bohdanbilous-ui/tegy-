import { NextResponse } from "next/server";
import crypto from "crypto";
import { readState, writeState, readKey, writeKey } from "../../../lib/store";
import { mergeState, nowISO } from "../../../lib/merge";
import { whoIs } from "../../../lib/auth";
import { pfConfigured, pullPeopleForce, applyPeople } from "../../../lib/peopleforce";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* Синхронізація довідника людей з PeopleForce.
   GET  з Authorization: Bearer CRON_SECRET — щоденний запуск Vercel Cron (vercel.json).
   GET  адміністратора — стан: чи налаштовано і що сталося востаннє.
   POST адміністратора — синхронізувати зараз. */

const LAST = "peopleforce:last:v1";
const kyivToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());

function cronOk(request) {
  const secret = process.env.CRON_SECRET || "";
  if (secret.length < 16) return false;
  const a = crypto.createHash("sha256").update(request.headers.get("authorization") || "").digest();
  const b = crypto.createHash("sha256").update("Bearer " + secret).digest();
  return crypto.timingSafeEqual(a, b);
}

async function admin(request) {
  const me = await whoIs(request);
  if (me.error) return { res: NextResponse.json({ error: me.error }, { status: 401 }) };
  if (!me.isAdmin) return { res: NextResponse.json({ error: "Синхронізацію запускає лише адміністратор." }, { status: 403 }) };
  return { me };
}

async function run(by) {
  const started = nowISO();
  if (!pfConfigured()) {
    const last = { at: started, by, ok: false, error: "Не задано PEOPLEFORCE_API_KEY у змінних Vercel." };
    await writeKey(LAST, last);
    return last;
  }
  try {
    const people = await pullPeopleForce();
    const stamp = nowISO();
    const { state, report } = applyPeople((await readState()) || {}, people, kyivToday(), stamp);
    // Перечитуємо стан перед записом: правки, що прийшли за час запиту до PeopleForce, не загубляться.
    const merged = mergeState(state, await readState());
    merged.updatedAt = stamp;
    merged.updatedBy = "PeopleForce";
    const changes = report.added.length + report.updated.length + report.left.length + report.returned.length;
    if (changes) {
      merged.log = [{ id: "l_pf" + Date.now(), at: stamp, who: "PeopleForce", email: "", action: "синхронізував довідник",
        details: "нових " + report.added.length + ", оновлено " + report.updated.length + ", звільнено " + report.left.length }, ...(merged.log || [])].slice(0, 300);
      await writeState(merged);
    }
    const cut = (a) => a.slice(0, 50);
    const last = { at: stamp, by, ok: true, total: people.length, added: cut(report.added), updated: cut(report.updated),
      left: cut(report.left), returned: cut(report.returned), skipped: report.skipped,
      counts: { added: report.added.length, updated: report.updated.length, left: report.left.length, returned: report.returned.length } };
    await writeKey(LAST, last);
    return last;
  } catch (e) {
    const last = { at: nowISO(), by, ok: false, error: String((e && e.message) || e).slice(0, 300) };
    await writeKey(LAST, last);
    return last;
  }
}

export async function GET(request) {
  if (cronOk(request)) {
    const last = await run("щоденно");
    return NextResponse.json(last, { status: last.ok ? 200 : 502 });
  }
  const g = await admin(request);
  if (g.res) return g.res;
  return NextResponse.json({ configured: pfConfigured(), cron: (process.env.CRON_SECRET || "").length >= 16, last: await readKey(LAST) });
}

export async function POST(request) {
  const g = await admin(request);
  if (g.res) return g.res;
  const last = await run(g.me.name);
  return NextResponse.json({ configured: pfConfigured(), cron: (process.env.CRON_SECRET || "").length >= 16, last }, { status: last.ok ? 200 : 502 });
}
