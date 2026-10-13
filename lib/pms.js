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
