import { NextResponse } from "next/server";
import { whoIs } from "../../../../lib/auth";
import {
  readUsers, writeUsers, normalizeUsername, hashPassword, generatePassword,
  publicUser, USERNAME_RE, MIN_PASSWORD, ROLES, roleOf, withRole,
} from "../../../../lib/users";

// Роль із запиту: нове поле role або старий прапорець isAdmin.
const roleFrom = (body) => (ROLES.includes(body.role) ? body.role : typeof body.isAdmin === "boolean" ? (body.isAdmin ? "admin" : "owner") : null);

export const dynamic = "force-dynamic";

/* Керування обліковими записами. Лише для адміністраторів — роль
перевіряється за сховищем при кожному запиті, а не за тим, що каже клієнт. */
async function admin(request) {
  const me = await whoIs(request);
  if (me.error) return { res: NextResponse.json({ error: me.error }, { status: 401 }) };
  if (!me.isAdmin) return { res: NextResponse.json({ error: "Керувати користувачами може лише адміністратор." }, { status: 403 }) };
  return { me };
}
const bad = (error, status = 400) => NextResponse.json({ error }, { status });
async function readBody(request) {
  try { return await request.json(); } catch (e) { return null; }
}

export async function GET(request) {
  const g = await admin(request);
  if (g.res) return g.res;
  const users = await readUsers();
  return NextResponse.json({
    users: users.map(publicUser).sort((a, b) => a.displayName.localeCompare(b.displayName, "uk")),
  });
}

export async function POST(request) {
  const g = await admin(request);
  if (g.res) return g.res;
  const body = await readBody(request);
  if (!body) return bad("Некоректний запит.");

  const username = normalizeUsername(body.username);
  const displayName = String(body.displayName || "").trim().replace(/\s+/g, " ");
  if (!USERNAME_RE.test(username)) return bad("Логін: 3–32 символи — латинські літери, цифри, крапка, дефіс або підкреслення.");
  if (!displayName) return bad("Вкажіть ім'я та прізвище — так, як у полі «Відповідальний за %».");
  if (body.password && String(body.password).length < MIN_PASSWORD) return bad("Пароль має бути не коротшим за " + MIN_PASSWORD + " символів.");

  const users = await readUsers();
  if (users.some((u) => u.username === username)) return bad("Логін «" + username + "» уже зайнятий.", 409);
  if (users.some((u) => u.displayName.toLowerCase() === displayName.toLowerCase()))
    return bad("Користувач з ім'ям «" + displayName + "» уже є — два записи з одним ім'ям бачили б одну команду.", 409);

  const password = body.password ? String(body.password) : generatePassword();
  const { salt, hash } = hashPassword(password);
  const now = new Date().toISOString();
  const user = withRole({ username, displayName, salt, passwordHash: hash, createdAt: now, updatedAt: now, createdBy: g.me.username }, roleFrom(body) || "owner");
  await writeUsers([...users, user]);
  return NextResponse.json({ user: publicUser(user), password });
}

export async function PATCH(request) {
  const g = await admin(request);
  if (g.res) return g.res;
  const body = await readBody(request);
  if (!body) return bad("Некоректний запит.");

  const username = normalizeUsername(body.username);
  const users = await readUsers();
  const i = users.findIndex((u) => u.username === username);
  if (i === -1) return bad("Користувача не знайдено.", 404);
  let next = { ...users[i] };

  if (typeof body.displayName === "string") {
    const dn = body.displayName.trim().replace(/\s+/g, " ");
    if (!dn) return bad("Ім'я не може бути порожнім.");
    if (users.some((u, j) => j !== i && u.displayName.toLowerCase() === dn.toLowerCase())) return bad("Таке ім'я вже має інший користувач.", 409);
    next.displayName = dn;
  }
  const role = roleFrom(body);
  if (role && role !== roleOf(next)) {
    if (username === g.me.username) return bad("Власну роль змінює інший адміністратор.");
    if (roleOf(next) === "admin" && !users.some((u, j) => j !== i && roleOf(u) === "admin")) return bad("Має лишитись хоча б один адміністратор.");
    next = withRole(next, role);
  }
  let password;
  if (body.resetPassword || body.password) {
    if (body.password && String(body.password).length < MIN_PASSWORD) return bad("Пароль має бути не коротшим за " + MIN_PASSWORD + " символів.");
    password = body.password ? String(body.password) : generatePassword();
    const { salt, hash } = hashPassword(password);
    next.salt = salt;
    next.passwordHash = hash;
  }
  next.updatedAt = new Date().toISOString();
  next.updatedBy = g.me.username;
  users[i] = next;
  await writeUsers(users);
  return NextResponse.json({ user: publicUser(next), ...(password ? { password } : {}) });
}

export async function DELETE(request) {
  const g = await admin(request);
  if (g.res) return g.res;
  const username = normalizeUsername(new URL(request.url).searchParams.get("username"));
  if (username === g.me.username) return bad("Себе видалити не можна.");
  const users = await readUsers();
  const target = users.find((u) => u.username === username);
  if (!target) return bad("Користувача не знайдено.", 404);
  if (roleOf(target) === "admin" && users.filter((u) => roleOf(u) === "admin").length <= 1) return bad("Має лишитись хоча б один адміністратор.");
  await writeUsers(users.filter((u) => u.username !== username));
  return NextResponse.json({ ok: true });
}
