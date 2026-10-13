// Зміни посади (ролі) й підрозділу (БЮ) з PeopleForce, що чекають на рішення адміністратора.
// Лежать окремим ключем, щоб синхронізація не конкурувала з правками спільного стану.
//   items — записи { id, employeeId, name, from, to, fields, detectedAt, status, … }
//     status: new — чекає; confirmed — підтверджено (створено переведення / оновлено картку);
//             dismissed — відхилено; auto — у PeopleForce повернули як було.
//   buMap — запам'ятована відповідність «БЮ → проєкт» для підказки при підтвердженні.
import { readKey, writeKey } from "./store";

export const CHANGES_KEY = "peopleforce:changes:v1";

export async function readChanges() {
  const x = (await readKey(CHANGES_KEY)) || {};
  return { items: Array.isArray(x.items) ? x.items : [], buMap: x.buMap || {} };
}
export const writeChanges = (v) => writeKey(CHANGES_KEY, { items: (v.items || []).slice(-500), buMap: v.buMap || {} });

const sameTo = (a, b) => (a.position || "") === (b.position || "") && (a.division || "") === (b.division || "");

/* Додає зміни з чергової синхронізації. Якщо по людині вже є відкритий запис —
   оновлює «стало» в ньому (а якщо повернулось як було — закриває як auto). */
export function addChanges(store, changes, today, stamp) {
  const items = store.items.map((x) => ({ ...x }));
  let fresh = 0;
  for (const c of changes || []) {
    const open = items.find((x) => x.employeeId === c.employeeId && x.status === "new");
    if (open) {
      open.to = c.to;
      open.fields = ["position", "division"].filter((k) => (open.from[k] || "") !== (c.to[k] || ""));
      open.updatedAt = stamp;
      if (sameTo(open.from, open.to)) { open.status = "auto"; open.decidedAt = stamp; open.decidedBy = "PeopleForce"; }
      continue;
    }
    // Ту саму зміну вже вирішили (а стара копія картки повернула попередні значення) — не дублюємо.
    if (items.some((x) => x.employeeId === c.employeeId && x.status !== "auto" && sameTo(x.from, c.from) && sameTo(x.to, c.to))) continue;
    items.push({
      id: "pc_" + String(c.employeeId).replace(/[^\w-]/g, "") + "_" + Date.now().toString(36) + fresh,
      employeeId: c.employeeId, name: c.name, pfId: c.pfId || "",
      from: c.from, to: c.to, fields: c.fields, detectedAt: today, status: "new", createdAt: stamp, updatedAt: stamp,
    });
    fresh++;
  }
  return { store: { ...store, items }, fresh };
}
