// Хто робить запит. Джерело правди — облікові записи (lib/users.js):
// ім'я й роль беруться зі сховища при кожному запиті, тож видалення
// користувача, зміна ролі чи скидання пароля діють одразу.
import { userFromToken, roleOf } from "./users";

export async function whoIs(request) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return { error: "Немає токена — увійдіть ще раз." };

  const user = await userFromToken(token);
  if (!user) return { error: "Сесія завершилась або доступ відкликано — увійдіть ще раз." };

  return {
    username: user.username,
    name: user.displayName,
    email: "",
    role: roleOf(user),
    isAdmin: roleOf(user) === "admin",
    verified: true,
  };
}
