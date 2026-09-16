// Табель у годинах. Відсоток проєкту = його години ÷ усі години людини за період.
// Округлення до цілих так, щоб у сумі було рівно 100. Спільне для браузера й сервера.
export const MAX_HOURS = 744; // більше, ніж годин у місяці, бути не може

const num = (v) => Math.round(Number(v) * 100) / 100;

// Прибирає сміття: порожні проєкти, від'ємні й нульові години, дублікати.
// Повертає null, якщо годин забагато.
export function cleanHours(list) {
  const out = [];
  for (const h of Array.isArray(list) ? list : []) {
    const project = String((h && h.project) || "").trim().slice(0, 120);
    const hours = num(h && h.hours);
    if (!project || !Number.isFinite(hours) || hours <= 0) continue;
    if (hours > MAX_HOURS) return null;
    const same = out.find((x) => x.project === project);
    if (same) same.hours = num(same.hours + hours);
    else out.push({ project, hours });
  }
  return out;
}

export function hoursToAlloc(hours) {
  const rows = (hours || []).filter((h) => Number(h.hours) > 0);
  const total = rows.reduce((s, h) => s + Number(h.hours), 0);
  if (!total) return [];
  const out = rows.map((h) => {
    const v = (Number(h.hours) * 100) / total;
    const whole = Math.floor(v + 1e-9);
    return { project: h.project, percent: whole, rest: v - whole };
  });
  let left = 100 - out.reduce((s, r) => s + r.percent, 0);
  out.slice().sort((a, b) => b.rest - a.rest).forEach((r) => { if (left > 0) { r.percent++; left--; } });
  return out.filter((r) => r.percent > 0).map(({ project, percent }) => ({ project, percent }));
}

export const hoursTotal = (hours) => num((hours || []).reduce((s, h) => s + (Number(h.hours) || 0), 0));
export const hoursText = (hours) => (hours || []).filter((h) => h.hours > 0).map((h) => h.project + " " + h.hours + " год").join(" + ");
export const hasHours = (entry) => !!(entry && Array.isArray(entry.hours) && entry.hours.length);
