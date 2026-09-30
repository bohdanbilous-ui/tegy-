// Відомості ЗП: ІПН зберігаються окремо від спільного стану (/api/state),
// тож HRD і відповідальні їх ніколи не отримують. Бачить і пише лише адміністратор.
//   pf     — ІПН з PeopleForce (переписуються щоночі синхронізацією);
//   manual — введені вручну або з файлу (для FPV і як запасний варіант).
// Діючий ІПН людини: pf, а якщо там порожньо — manual.
import { readKey, writeKey } from "./store";
import { cleanInn } from "./peopleforce";

const KEY = "pay:inn:v1";

export async function readInn() {
  const x = (await readKey(KEY)) || {};
  return { pf: x.pf || {}, manual: x.manual || {} };
}

export const innFor = (store, id) => store.pf[id] || store.manual[id] || "";

export async function writePfInn(map) {
  const cur = await readInn();
  await writeKey(KEY, { ...cur, pf: map });
}

export async function setManualInn(items) {
  const cur = await readInn();
  const manual = { ...cur.manual };
  let saved = 0, bad = 0;
  for (const it of items || []) {
    const id = String((it && it.id) || "").slice(0, 80);
    if (!id) continue;
    if (!it.inn) { delete manual[id]; saved++; continue; }
    const v = cleanInn(it.inn);
    if (!v) { bad++; continue; }
    manual[id] = v; saved++;
  }
  await writeKey(KEY, { ...cur, manual });
  return { saved, bad };
}

// Для інтерфейсу — лише ознака й останні 4 символи, повний ІПН у браузер не йде.
export function maskInn(store) {
  const out = {};
  const ids = new Set([...Object.keys(store.pf), ...Object.keys(store.manual)]);
  ids.forEach((id) => {
    const v = innFor(store, id);
    if (v) out[id] = { m: "…" + v.slice(-4), src: store.pf[id] ? "pf" : "manual" };
  });
  return out;
}
