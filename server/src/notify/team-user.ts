import { WITH_MEMBER } from "../auth/session.js";
import { memberNameOf, type Viewer } from "../crm/access.js";
import { prisma } from "../db.js";
import { actorName } from "./notifications.js";

/**
 * Кто пишет боту или жмёт его кнопку. Учётка находится по привязанному телеграму: в
 * личке идентификатор чата и есть идентификатор человека, поэтому в общем чате тот же
 * человек находится по `from.id`. Роль читается при каждом обращении, как и у `/today`:
 * понижение и отключение действуют сразу.
 */
export interface TeamUser {
  viewer: Viewer;
  /** Подпись в сообщениях: «Выполнено · Вадим». */
  name: string;
}

export async function teamUserOf(telegramId: number | string): Promise<TeamUser | null> {
  const user = await prisma.user.findFirst({
    where: { telegramChatId: String(telegramId), disabledAt: null },
    include: WITH_MEMBER,
  });
  if (!user || (user.role !== "admin" && user.role !== "employee")) return null;
  const memberName = memberNameOf(user);
  return {
    viewer: { id: user.id, role: user.role, memberName },
    name: actorName({ memberName, name: user.name, email: user.email }),
  };
}
