// Сховище. За замовчуванням — Redis (Upstash через Vercel Marketplace).
// Якщо змінних немає, працює пам'ять процесу: годиться лише для локального запуску,
// бо на Vercel кожен виклик може потрапити в інший інстанс.
const STATE_KEY = "transfers:state:v1";
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const persistent = Boolean(url && token);
// Спільна для всіх маршрутів пам'ять процесу (кожен маршрут — окремий модуль).
const memory = globalThis.__transfersMemory || (globalThis.__transfersMemory = new Map());

async function redis(command) {
  const res = await fetch(url + "/" + command.map((c) => encodeURIComponent(String(c))).join("/"), {
    headers: { Authorization: "Bearer " + token },
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Redis " + res.status);
  return (await res.json()).result;
}

export async function readKey(key) {
  if (!persistent) return memory.has(key) ? structuredClone(memory.get(key)) : null;
  const raw = await redis(["get", key]);
  return raw ? JSON.parse(raw) : null;
}

export async function writeKey(key, value) {
  if (!persistent) { memory.set(key, structuredClone(value)); return; }
  const res = await fetch(url + "/set/" + encodeURIComponent(key), {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error("Redis set " + res.status);
}

// Лічильник із терміном життя — для обмеження спроб входу.
export async function bump(key, ttlSeconds) {
  if (!persistent) {
    const now = Date.now();
    const cur = memory.get(key);
    const next = cur && cur.until > now ? { n: cur.n + 1, until: cur.until } : { n: 1, until: now + ttlSeconds * 1000 };
    memory.set(key, next);
    return next.n;
  }
  const n = await redis(["incr", key]);
  if (n === 1) await redis(["expire", key, ttlSeconds]);
  return n;
}

export async function peek(key) {
  if (!persistent) {
    const cur = memory.get(key);
    return cur && cur.until > Date.now() ? cur.n : 0;
  }
  return Number(await redis(["get", key])) || 0;
}

export async function drop(key) {
  if (!persistent) { memory.delete(key); return; }
  await redis(["del", key]);
}

export const readState = () => readKey(STATE_KEY);
export const writeState = (state) => writeKey(STATE_KEY, state);
