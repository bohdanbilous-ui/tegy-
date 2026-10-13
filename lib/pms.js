// PM проєкту: у спільному стані це рядок `pms[проєкт]`. Кілька PM записуються через «;»
// («Іваненко Іван; Петренко Петро»), тож старі значення з одним іменем працюють без міграції.
// Спільне для браузера й сервера.

export const pmList = (v) => {
  const seen = new Set(), out = [];
  String(v == null ? "" : v).split(/[;\n]+/).map((s) => s.trim()).filter(Boolean).forEach((n) => {
    const k = n.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(n); }
  });
  return out;
};

export const isPm = (v, name) => {
  const n = String(name == null ? "" : name).trim().toLowerCase();
  return !!n && pmList(v).some((x) => x.toLowerCase() === n);
};

// Для збереження: прибирає зайві пробіли й дублі.
export const pmNormalize = (v) => pmList(v).join("; ");

// Для показу людині.
export const pmText = (v) => pmList(v).join(", ");

/* Імпорт PM з тексту. Рядок: «Проєкт - PM; PM» або «Проєкт1; Проєкт2 - PM» (дефіс можна пропустити:
   тоді назва проєкту береться як найдовший збіг з початку рядка). Повертає { rows: [{ project, pm }], unknown: [назви] }. */
export function parsePmLines(text, projects) {
  const known = new Map((projects || []).map((p) => [String(p).trim().toLowerCase(), p]));
  const rows = [], unknown = [];
  String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line) => {
    let left = "", right = "";
    const m = line.match(/^(.*?)\s+[-–—]\s+(.*)$/);
    if (m) { left = m[1]; right = m[2]; }
    else {
      const lower = line.toLowerCase();
      const hit = [...known.keys()].filter((k) => lower === k || lower.startsWith(k + " ")).sort((a, b) => b.length - a.length)[0];
      if (!hit) { unknown.push(line); return; }
      left = line.slice(0, hit.length); right = line.slice(hit.length).trim();
    }
    const pm = pmNormalize(right);
    if (!pm) { unknown.push(line); return; }
    left.split(";").map((s) => s.trim()).filter(Boolean).forEach((name) => {
      const p = known.get(name.toLowerCase());
      if (p) rows.push({ project: p, pm }); else unknown.push(name);
    });
  });
  return { rows, unknown };
}
