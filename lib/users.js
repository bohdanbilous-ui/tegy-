// Облікові записи: логін + пароль, окремо від спільного стану.
// Паролі зберігаються лише як scrypt-хеш і ніколи не потрапляють у /api/state.
import crypto from "crypto";
import { readKey, writeKey } from "./store";

const KEY = "transfers:users:v1";

// Ключ підпису токенів. Якщо APP_SECRET не задано, беремо токен Redis —
// він і так секретний і є лише на сервері. Локально без обох — випадковий
// ключ на час роботи процесу (після перезапуску треба увійти знову).
const SECRET = process.env.APP_SECRET
  || process.env.KV_REST_API_TOKEN
  || process.env.UPSTASH_REDIS_REST_TOKEN
  || globalThis.__transfersDevSecret
  || (globalThis.__transfersDevSecret = crypto.randomBytes(32).toString("hex"));

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

export const normalizeUsername = (u) => String(u || "").trim().toLowerCase();
export const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase() && String(a || "").trim() !== "";
export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
export const MIN_PASSWORD = 8;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  // Для неіснуючого користувача все одно рахуємо хеш, щоб час відповіді
  // не підказував, чи існує такий логін.
  const s = salt || "0".repeat(32);
  const check = crypto.scryptSync(String(password || ""), s, 64);
  if (!salt || !hash) return false;
  const stored = Buffer.from(hash, "hex");
  return stored.length === check.length && crypto.timingSafeEqual(stored, check);
}

export function generatePassword() {
  // 12 символів без схожих на вигляд (0/O, 1/l/I).
  const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) out += abc[bytes[i] % abc.length];
  return out.slice(0, 4) + "-" + out.slice(4, 8) + "-" + out.slice(8);
}

export async function readUsers() {
  return (await readKey(KEY)) || [];
}

export async function writeUsers(users) {
  await writeKey(KEY, users);
}

export async function findUser(username) {
  const u = normalizeUsername(username);
  return (await readUsers()).find((x) => x.username === u) || null;
}

/* Ролі:
   admin — бачить і править усе, керує користувачами;
   hrd   — свої команди + переведення (свої записи);
   owner — лише табель своїх команд. */
export const ROLES = ["owner", "hrd", "admin"];
export const roleOf = (u) => (u && ROLES.includes(u.role) ? u.role : u && u.isAdmin ? "admin" : "owner");
export const withRole = (u, role) => ({ ...u, role, isAdmin: role === "admin" });

export const publicUser = (u) => ({
  username: u.username, displayName: u.displayName, role: roleOf(u), isAdmin: roleOf(u) === "admin",
  createdAt: u.createdAt || "", updatedAt: u.updatedAt || "",
});

// «Версія пароля»: після скидання пароля старі токени перестають діяти.
const passwordVersion = (user) => String(user.salt || "").slice(0, 8);

/* Токен у форматі JWT (HS256), щоб клієнт міг прочитати exp. */
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const HEADER = b64({ alg: "HS256", typ: "JWT" });

export function signToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({ sub: user.username, pv: passwordVersion(user), iat: now, exp: now + TOKEN_TTL_SECONDS });
  const sig = crypto.createHmac("sha256", SECRET).update(HEADER + "." + payload).digest("base64url");
  return HEADER + "." + payload + "." + sig;
}

// Повертає користувача з актуальними даними зі сховища або null.
export async function userFromToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = crypto.createHmac("sha256", SECRET).update(h + "." + p).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(p, "base64url").toString()); } catch (e) { return null; }
  if (!data || !data.sub || !data.exp || Date.now() / 1000 > Number(data.exp)) return null;
  const user = await findUser(data.sub);
  if (!user || data.pv !== passwordVersion(user)) return null;
  return user;
}
