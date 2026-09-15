import { NextResponse } from "next/server";
import { mergeState, nowISO } from "../../../lib/merge";
import { readState, writeState, persistent } from "../../../lib/store";
import { whoIs } from "../../../lib/auth";

export const dynamic = "force-dynamic";

const EMPTY = { employees: [], projects: [], partners: [], reasons: [], transfers: [], admins: [], log: [], deleted: {}, pms: {}, codes: {}, teams: [], entries: [], settings: { approvalMode: "give" } };

/* Повний стан — лише для адміністраторів. Відповідальні за команди
працюють через /api/team і бачать тільки свої команди. Роль береться
з облікового запису на сервері (lib/users.js), а не з тіла запиту. */
async function adminOnly(request) {
  const me = await whoIs(request);
  if (me.error) return { res: NextResponse.json({ error: me.error }, { status: 401 }) };
  if (!me.isAdmin) return { res: NextResponse.json({ error: "Повний доступ лише для адміністратора." }, { status: 403 }) };
  return { me };
}

export async function GET(request) {
  const g = await adminOnly(request);
  if (g.res) return g.res;
  const stored = (await readState()) || EMPTY;
  return NextResponse.json({ ...EMPTY, ...stored, _persistent: persistent });
}

export async function PUT(request) {
  const g = await adminOnly(request);
  if (g.res) return g.res;

  let incoming;
  try { incoming = await request.json(); }
  catch (e) { return NextResponse.json({ error: "Некоректний запит." }, { status: 400 }); }

  const stored = (await readState()) || EMPTY;
  const merged = mergeState(incoming, stored);
  merged.updatedAt = nowISO();
  merged.updatedBy = g.me.name;
  await writeState(merged);
  return NextResponse.json({ ...merged, _persistent: persistent });
}
