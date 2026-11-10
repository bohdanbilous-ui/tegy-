// Логіка злиття станів: спільна для браузера і сервера.
import { mergeMeta } from "./projects";
export const uniq = (a) => Array.from(new Set(a.filter(Boolean)));
export const nowISO = () => new Date().toISOString();
const newer = (a, b) => (a || "") > (b || "");

/* Словник за ключами (pms, codes, settings) із позначками часу правок kv["префікс:ключ"].
   Новіша правка ключа перемагає; видалення — це позначка без ключа. Старі дані без позначок
   зливаються як раніше: локальне значення перемагає, але видалити ключ без позначки не можна. */
function mergeKv(prefix, a = {}, b = {}, ka = {}, kb = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  [ka, kb].forEach((m) => Object.keys(m).forEach((k) => { if (k.startsWith(prefix)) keys.add(k.slice(prefix.length)); }));
  const out = {};
  keys.forEach((k) => {
    const ta = ka[prefix + k] || "", tb = kb[prefix + k] || "";
    const inA = k in a, inB = k in b;
    if (!ta && !tb) { if (inA) out[k] = a[k]; else if (inB) out[k] = b[k]; return; }
    if (ta >= tb) { if (inA) out[k] = a[k]; } else if (inB) out[k] = b[k];
  });
  return out;
}

export function mergeState(local, remote) {
  if (!remote) return local;
  const tomb = { ...(remote.deleted || {}) };
  Object.entries(local.deleted || {}).forEach(([k, v]) => { if (newer(v, tomb[k])) tomb[k] = v; });
  const byId = (prefix, a = [], b = [], stampKey = "updatedAt") => {
    const m = new Map();
    [...a, ...b].forEach((x) => {
      const prev = m.get(x.id);
      if (!prev || newer(x[stampKey], prev[stampKey])) m.set(x.id, x);
    });
    return [...m.values()].filter((x) => !newer(tomb[prefix + x.id], x[stampKey]));
  };
  const plain = (prefix, a = [], b = []) => uniq([...a, ...b]).filter((v) => !tomb[prefix + v]);
  return {
    employees: byId("e:", local.employees, remote.employees),
    transfers: byId("t:", local.transfers, remote.transfers),
    projects: plain("p:", local.projects, remote.projects),
    partners: plain("pp:", local.partners, remote.partners),
    reasons: plain("r:", local.reasons, remote.reasons),
    admins: plain("a:", local.admins, remote.admins),
    log: byId("l:", local.log, remote.log, "at").sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300),
    pms: mergeKv("pms:", local.pms, remote.pms, local.kv, remote.kv),
    codes: mergeKv("codes:", local.codes, remote.codes, local.kv, remote.kv),
    projectMeta: mergeMeta(local.projectMeta, remote.projectMeta),
    teams: byId("tm:", local.teams, remote.teams),
    entries: byId("en:", local.entries, remote.entries),
    fin: byId("f:", local.fin, remote.fin),
    fpv: byId("fv:", local.fpv, remote.fpv),
    settings: mergeKv("settings:", local.settings, remote.settings, local.kv, remote.kv),
    kv: (() => { const o = { ...(remote.kv || {}) }; Object.entries(local.kv || {}).forEach(([k, v]) => { if (!o[k] || v > o[k]) o[k] = v; }); return o; })(),
    deleted: tomb,
  };
}

