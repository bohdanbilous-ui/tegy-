import { NextResponse } from "next/server";
import { findUser, verifyPassword, signToken, normalizeUsername } from "../../../lib/users";
import { bump, peek, drop } from "../../../lib/store";

export const dynamic = "force-dynamic";

/* Вхід за особистим логіном і паролем. Ім'я й роль людина не обирає —
вони беруться з її облікового запису. Після 8 невдалих спроб логін
блокується на 15 хвилин. */
const MAX_FAILS = 8;
const LOCK_SECONDS = 15 * 60;

export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch (e) { return NextResponse.json({ error: "Некоректний запит." }, { status: 400 }); }

  const username = normalizeUsername(body?.username);
  const password = String(body?.password || "");
  if (!username || !password) return NextResponse.json({ error: "Вкажіть логін і пароль." }, { status: 400 });

  const failKey = "transfers:loginfail:" + username;
  if ((await peek(failKey)) >= MAX_FAILS) {
    return NextResponse.json({ error: "Забагато невдалих спроб. Спробуйте за 15 хвилин або попросіть адміністратора скинути пароль." }, { status: 429 });
  }

  const user = await findUser(username);
  const ok = verifyPassword(password, user?.salt, user?.passwordHash);
  if (!user || !ok) {
    await bump(failKey, LOCK_SECONDS);
    return NextResponse.json({ error: "Невірний логін або пароль." }, { status: 401 });
  }
  await drop(failKey);

  return NextResponse.json({
    token: signToken(user),
    username: user.username,
    name: user.displayName,
    isAdmin: !!user.isAdmin,
  });
}
