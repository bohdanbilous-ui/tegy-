// Акаунти людей у трекерах (ClickUp, Redmine, …): глобальний довідник «співробітник Allocate ↔ як його звуть у трекері».
// Живе окремо від звірки, щоб ним користувались і звірка PM, і майбутній дашборд годин, і HR-метрики.
export const IDENT_KEY = "directory:identities:v1"; // { [employeeId]: [{ sys, name, email, status, at }] }
export const SYSTEMS = { clickup: "ClickUp", redmine: "Redmine", other: "Інший трекер" };

const low = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

export function cleanIdent(raw, validIds) {
  const out = {};
  Object.keys(raw || {}).forEach((id) => {
    if (validIds && !validIds.has(id)) return;
    const seen = new Set();
    const list = (Array.isArray(raw[id]) ? raw[id] : []).map((a) => ({
      sys: SYSTEMS[a && a.sys] ? a.sys : "other", name: String((a && a.name) || "").trim().slice(0, 120),
      email: low(a && a.email).slice(0, 160), status: String((a && a.status) || "").slice(0, 20), at: String((a && a.at) || ""),
    })).filter((a) => {
      const k = a.sys + "|" + low(a.name) + "|" + a.email;
      if ((!a.name && !a.email) || seen.has(k)) return false; seen.add(k); return true;
    }).slice(0, 20);
    if (list.length) out[id] = list;
  });
  return out;
}

// Ім'я/email з трекера → employeeId. Передається в звірку разом зі старою таблицею псевдонімів.
export function identityAliases(ident) {
  const map = {};
  Object.keys(ident || {}).forEach((id) => (ident[id] || []).forEach((a) => {
    if (a.name) map[low(a.name)] = id;
    if (a.email) map[a.email] = id;
  }));
  return map;
}

export function upsertAccount(ident, employeeId, acc) {
  const list = [...(ident[employeeId] || [])];
  const k = low(acc.name);
  const i = list.findIndex((a) => a.sys === acc.sys && ((k && low(a.name) === k) || (acc.email && a.email === acc.email)));
  if (i >= 0) list[i] = { ...list[i], ...acc }; else list.push(acc);
  return { ...ident, [employeeId]: list };
}
