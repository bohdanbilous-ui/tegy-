// Спільне для браузера й сервера. leftOn — останній робочий день (з PeopleForce).
export const workingOn = (e, date) => !e || !e.leftOn || e.leftOn >= date;

/* Історія команд звільненої людини: коли її прибирають з команди, команда лишається в teamHist
   [{ teamId, until }] (until — останній робочий день), щоб минулі періоди й табель не втрачали людину. */
export const lastTeamId = (e) => {
  const h = (e && e.teamHist) || [];
  return (e && e.teamId) || (h.length ? h[h.length - 1].teamId : "") || "";
};
export const inTeamOn = (e, teamId, date) =>
  !!e && !!teamId && workingOn(e, date) && (e.teamId === teamId || (e.teamHist || []).some((h) => h.teamId === teamId && (!h.until || h.until >= date)));
export const wasInTeam = (e, teamId) => !!e && (e.teamId === teamId || (e.teamHist || []).some((h) => h.teamId === teamId));

/* Парттайм: розподіл подається раз на місяць у другій половині (16–кінець місяця),
   перша половина читає той самий запис. Повертає ключ періоду, під яким лежить запис людини. */
export const isPartTime = (e) => !!(e && e.partTime);
export const entryKey = (e, key) => (isPartTime(e) && String(key).endsWith("-H1") ? String(key).slice(0, -1) + "2" : key);
// У цьому періоді рядок людини лише читається (її запис лежить в іншій половині).
export const isDeferred = (e, key) => entryKey(e, key) !== key;
