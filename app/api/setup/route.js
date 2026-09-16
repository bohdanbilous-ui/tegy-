import { NextResponse } from "next/server";
import crypto from "crypto";
import { readUsers, writeUsers, hashPassword, generatePassword } from "../../../lib/users";

export const dynamic = "force-dynamic";

/* Одноразове створення перших облікових записів.
Працює лише поки користувачів немає взагалі і лише з кодом SETUP_TOKEN,
який знає тільки той, хто має доступ до налаштувань Vercel.
Після першого успішного виклику ендпоінт назавжди вимикається.
Далі людей додає адміністратор у «Довідник → Користувачі». */
const SEED = [
  { username: "bohdan.bilous", displayName: "Богдан Білоус", role: "admin" },
  { username: "mariia.lytvyn", displayName: "Марія Литвин", role: "admin" },
  { username: "taras.mamai", displayName: "Тарас Мамай" },
  { username: "stanislav.stoiatskyi", displayName: "Станіслав Стояцький" },
  { username: "khrystyna.chepurna", displayName: "Христина Чепурна" },
  { username: "taras.hryshchuk", displayName: "Тарас Грищук" },
  { username: "halyna.nykonchuk", displayName: "Галина Никончук" },
  { username: "yevhenii.kulyk", displayName: "Євгеній Кулик" },
];

function tokenOk(given) {
  const expected = process.env.SETUP_TOKEN || "";
  if (expected.length < 16) return false;
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function GET() {
  const users = await readUsers();
  return NextResponse.json({ done: users.length > 0, configured: (process.env.SETUP_TOKEN || "").length >= 16 });
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  if (!tokenOk(body?.setupToken)) {
    return NextResponse.json({ error: "Невірний код налаштування (SETUP_TOKEN у Vercel, щонайменше 16 символів)." }, { status: 403 });
  }
  if ((await readUsers()).length > 0) {
    return NextResponse.json({ error: "Облікові записи вже створені. Керуйте ними в «Довідник → Користувачі»." }, { status: 409 });
  }
  const now = new Date().toISOString();
  const issued = [];
  const users = SEED.map((s) => {
    const password = generatePassword();
    const { salt, hash } = hashPassword(password);
    const role = s.role || "owner";
    issued.push({ username: s.username, displayName: s.displayName, role, isAdmin: role === "admin", password });
    return { username: s.username, displayName: s.displayName, role, isAdmin: role === "admin", salt, passwordHash: hash, createdAt: now, updatedAt: now, createdBy: "setup" };
  });
  await writeUsers(users);
  return NextResponse.json({ users: issued });
}
