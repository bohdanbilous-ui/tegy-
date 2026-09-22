import { NextResponse } from "next/server";
import crypto from "crypto";
import { readState, readKey, writeKey } from "../../../lib/store";
import { whoIs } from "../../../lib/auth";
import { sameName } from "../../../lib/users";
import { workingOn } from "../../../lib/people";
import { orderProjects, isInactive } from "../../../lib/projects";

export const dynamic = "force-dynamic";

/* Заявки на переведення з Google Форми.
   Скрипт форми (Apps Script) знає секрет FORM_SECRET — той самий, що в змінних Vercel:
   з ним він бере списки для випадаючих полів і надсилає заявки. Адміністратор читає
   заявки й змінює їхній статус зі свого входу. Заявки лежать окремим ключем, тож
   нова заявка ніколи не перезапише правки в основних даних. Переведення створює
   адміністратор — заявка лише підставляє дані у форму. */

const KEY = "transfers:requests:v1";
const STATUSES = ["new", "done", "rejected"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

function secretOk(request) {
  const expected = process.env.FORM_SECRET || "";
  if (expected.length < 16) return false;
  const given = request.headers.get("x-form-secret") || "";
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
const denySecret = () => NextResponse.json({ error: "Невірний або не налаштований FORM_SECRET." }, { status: 403 });
async function admin(request) {
  const me = await whoIs(request);
  if (me.error) return { res: NextResponse.json({ error: me.error }, { status: 401 }) };
  if (!me.isAdmin) return { res: NextResponse.json({ error: "Заявки бачить лише адміністратор." }, { status: 403 }) };
  return { me };
}

export async function GET(request) {
  // З авторизацією — список заявок для адміністратора.
  if ((request.headers.get("authorization") || "").startsWith("Bearer ")) {
    const g = await admin(request);
    if (g.res) return g.res;
    return NextResponse.json({ requests: (await readKey(KEY)) || [], formReady: (process.env.FORM_SECRET || "").length >= 16 });
  }
  // Із секретом — списки для полів форми.
  if (!secretOk(request)) return denySecret();
  const state = (await readState()) || {};
  const tomb = state.deleted || {};
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
  const uniq = (a) => [...new Set(a.filter(Boolean))].sort((x, y) => x.localeCompare(y, "uk"));
  return NextResponse.json({
    employees: uniq((state.employees || []).filter((e) => !tomb["e:" + e.id] && workingOn(e, today)).map((e) => e.name)),
    projects: orderProjects((state.projects || []).filter((p) => !tomb["p:" + p] && !isInactive(state.projectMeta, p)), state.projectMeta),
    reasons: uniq((state.reasons || []).filter((r) => !tomb["r:" + r])),
  });
}

export async function POST(request) {
  if (!secretOk(request)) return denySecret();
  let body;
  try { body = await request.json(); } catch (e) { return NextResponse.json({ error: "Некоректний запит." }, { status: 400 }); }

  const alloc = [];
  for (const r of Array.isArray(body?.alloc) ? body.alloc : []) {
    const project = str(r && r.project, 120), percent = Number(r && r.percent);
    if (!project || !Number.isFinite(percent) || percent <= 0 || percent > 100) continue;
    const same = alloc.find((x) => x.project === project);
    if (same) same.percent += percent; else alloc.push({ project, percent: Math.round(percent * 100) / 100 });
  }
  const employee = str(body?.employee, 160);
  const effectiveDate = str(body?.effectiveDate, 10);
  if (!employee || !alloc.length || !DATE_RE.test(effectiveDate)) {
    return NextResponse.json({ error: "Потрібні співробітник, хоча б один проєкт із відсотком і дата." }, { status: 400 });
  }
  const temporary = !!body?.temporary;
  const returnDate = str(body?.returnDate, 10);
  const responseId = str(body?.responseId, 120) || crypto.randomBytes(8).toString("hex");
  const id = "rq_" + crypto.createHash("sha256").update(responseId).digest("hex").slice(0, 16);

  const list = (await readKey(KEY)) || [];
  if (list.some((x) => x.id === id)) return NextResponse.json({ ok: true, duplicate: true });
  const state = (await readState()) || {};
  const emp = (state.employees || []).find((e) => sameName(e.name, employee));
  const stamp = new Date().toISOString();
  list.push({
    id, status: "new",
    requester: str(body?.requester, 120), email: str(body?.email, 160),
    employee, employeeId: emp ? emp.id : "",
    alloc, effectiveDate, temporary, returnDate: temporary && DATE_RE.test(returnDate) ? returnDate : "",
    reason: str(body?.reason, 200), agreedWith: str(body?.agreedWith, 500), note: str(body?.note, 2000),
    submittedAt: str(body?.submittedAt, 40) || stamp, createdAt: stamp,
  });
  await writeKey(KEY, list.slice(-500));
  return NextResponse.json({ ok: true, id });
}

/* Тіло: { id, status: "done" | "rejected" | "new", transferId?, comment? } */
export async function PATCH(request) {
  const g = await admin(request);
  if (g.res) return g.res;
  let body;
  try { body = await request.json(); } catch (e) { return NextResponse.json({ error: "Некоректний запит." }, { status: 400 }); }
  if (!STATUSES.includes(body?.status)) return NextResponse.json({ error: "Невідомий статус." }, { status: 400 });
  const list = (await readKey(KEY)) || [];
  const i = list.findIndex((x) => x.id === body.id);
  if (i === -1) return NextResponse.json({ error: "Заявку не знайдено." }, { status: 404 });
  const stamp = new Date().toISOString();
  list[i] = body.status === "new"
    ? { ...list[i], status: "new", transferId: "", decidedBy: "", decidedAt: "", comment: "" }
    : { ...list[i], status: body.status, transferId: str(body.transferId, 60), comment: str(body.comment, 1000), decidedBy: g.me.name, decidedAt: stamp };
  await writeKey(KEY, list);
  return NextResponse.json({ requests: list });
}
