// Спільне для браузера й сервера. leftOn — останній робочий день (з PeopleForce).
export const workingOn = (e, date) => !e || !e.leftOn || e.leftOn >= date;
