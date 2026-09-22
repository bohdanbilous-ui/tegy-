// Порядок і активність проєктів. Спільне для браузера й сервера.
// projectMeta: { [назва]: { order, inactive, updatedAt } } — зливається по кожному проєкту окремо,
// тож старіша копія з іншої вкладки не поверне старий порядок.

// Порядок за замовчуванням, поки адміністратор не переставив проєкти вручну.
export const PREFERRED_ORDER = ["Checkbox", "MC Checkbox Group", "Posbox.ua", "Posbox.pl", "Parabox", "Taxbox", "Edibox", "Navkolo"];

const norm = (s) => String(s || "").trim().toLowerCase();

export function orderProjects(list, meta) {
  const m = meta || {};
  const names = [...new Set((list || []).filter(Boolean))];
  const idx = new Map(names.map((p, i) => [p, i]));
  const manual = names.some((p) => m[p] && Number.isFinite(m[p].order));
  const pref = new Map(PREFERRED_ORDER.map((p, i) => [norm(p), i]));
  const key = (p) => manual
    ? (m[p] && Number.isFinite(m[p].order) ? m[p].order : 1e6 + idx.get(p))
    : (pref.has(norm(p)) ? pref.get(norm(p)) : 1e6 + idx.get(p));
  return names.sort((a, b) => key(a) - key(b));
}

export const isInactive = (meta, p) => !!(meta && meta[p] && meta[p].inactive);

export function mergeMeta(a, b) {
  const out = { ...(b || {}) };
  Object.entries(a || {}).forEach(([k, v]) => { if (!out[k] || String(v && v.updatedAt || "") > String(out[k].updatedAt || "")) out[k] = v; });
  return out;
}
