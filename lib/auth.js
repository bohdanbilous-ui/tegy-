// Перевірка входу: підписаний локальний токен (логін+пароль) або Google id_token.
import crypto from "crypto";

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
const DOMAIN = process.env.NEXT_PUBLIC_ALLOWED_DOMAIN || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";

function verifyLocalToken(token) {
  if (!APP_PASSWORD || !token || !token.includes(".")) return null;
  const idx = token.lastIndexOf(".");
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac("sha256", APP_PASSWORD).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch (e) {
    return null;
  }
  if (!data?.name || !data?.exp || Date.now() > Number(data.exp)) return null;
  return { name: data.name, email: "", verified: true };
}

export async function whoIs(request) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) return { error: "Немає токена — увійдіть ще раз." };

  const local = verifyLocalToken(token);
  if (local) return local;

  if (!CLIENT_ID) {
    return { error: "Сесія завершилась — увійдіть ще раз." };
  }

  const res = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token), { cache: "no-store" });
  if (!res.ok) return { error: "Google не підтвердив токен." };
  const p = await res.json();

  if (p.aud !== CLIENT_ID) return { error: "Токен виданий для іншого застосунку." };
  if (Number(p.exp) * 1000 < Date.now()) return { error: "Термін дії входу минув." };
  if (DOMAIN && p.hd !== DOMAIN) return { error: "Дозволені лише акаунти @" + DOMAIN + "." };

  return { name: p.name || p.email, email: (p.email || "").toLowerCase(), verified: true };
}
