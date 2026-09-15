import { NextResponse } from "next/server";
import crypto from "crypto";

/* Просте, але справжнє серверне логування за іменем і паролем.
   Дозволено декілька паролів одразу — задаються змінною середовища
   APP_PASSWORDS, через кому або з нового рядка (напр. "пароль1, пароль2").
   Для сумісності підтримується і стара змінна APP_PASSWORD (один пароль).
   Після успішного входу сервер видає підписаний токен (HMAC), який далі
   передається як звичайний Bearer-токен — так само, як токен від Google. */

const RAW = process.env.APP_PASSWORDS || process.env.APP_PASSWORD || "";
const VALID_PASSWORDS = RAW.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
const SECRET = RAW;

function sign(name) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30;
  const payload = Buffer.from(JSON.stringify({ name, exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}

export async function POST(request) {
  if (!VALID_PASSWORDS.length) {
    return NextResponse.json(
      { error: "Сервер не налаштований: задайте APP_PASSWORDS у Environment Variables." },
      { status: 500 }
    );
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return NextResponse.json({ error: "Некоректний запит." }, { status: 400 });
  }
  const name = (body?.name || "").trim();
  const password = body?.password || "";
  if (!name) return NextResponse.json({ error: "Вкажіть ім'я." }, { status: 400 });
  if (!VALID_PASSWORDS.includes(password)) {
    return NextResponse.json({ error: "Невірний пароль." }, { status: 401 });
  }
  return NextResponse.json({ token: sign(name), name });
}
