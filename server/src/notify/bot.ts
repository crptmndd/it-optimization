import type { Prisma } from "@prisma/client";
import { WITH_MEMBER } from "../auth/session.js";
import { memberNameOf } from "../crm/access.js";
import { collectToday, collectTodayFor, teamChatSnapshot } from "../crm/today.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { buildDigest } from "./digest.js";
import { isPrivateChat } from "./notifications.js";
import { callBotApi, escapeHtml, trySendMessage } from "./telegram.js";

/**
 * Бот работает на длинных опросах (getUpdates), а не на вебхуках. Вебхук
 * требует публичного HTTPS-адреса, а значит не работает при локальной
 * разработке без туннеля. Опрос работает везде одинаково, а на объёме в
 * несколько сообщений в день разницы в нагрузке нет никакой.
 *
 * Важно: у одного бота может опрашивать обновления только один процесс. Если
 * когда-нибудь API поедет в несколько реплик, бота надо будет выносить
 * отдельно или переводить на вебхук.
 */

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string; username?: string };
    text?: string;
  };
}

const HELP = [
  "Я напоминаю о задачах, сроках и деньгах: сотрудникам в общем чате, админам лично.",
  "",
  "<b>/today</b> — что горит прямо сейчас",
  "<b>/chatid</b> — идентификатор этого чата",
  "<b>/stop</b> — отвязать этот чат от учётки",
  "",
  "Каждое утро пишу в общий чат просроченное и запланированное на сегодня,",
  "а админам лично полную сводку.",
  "Если писать не о чем — молчу.",
].join("\n");

const NOTHING_BURNS = "Ничего не горит. Свободны.";

/** Привязка открывает `/today` мимо сессий, поэтому оставляет след в журнале. */
async function auditLink(
  userId: string,
  action: "telegram_link" | "telegram_unlink",
  diff: Prisma.InputJsonValue,
  log: Log,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { userId, entity: "users", entityId: userId, action, diff },
    });
  } catch (cause) {
    log.error({ err: cause }, "не удалось записать audit_log");
  }
}

/**
 * Подключение бота заодно сообщает ник: человек не вписывает его дважды. Заполняется
 * только пустое поле, ник из Настроек сильнее: его ставил админ осознанно.
 */
async function rememberHandle(
  userId: string,
  username: string | undefined,
  log: Log,
): Promise<void> {
  if (!username) return;

  const member = await prisma.teamMember.findUnique({ where: { userId } });
  if (!member || member.telegramUsername) return;

  await prisma.teamMember.update({
    where: { name: member.name },
    data: { telegramUsername: username },
  });
  log.info({ name: member.name }, "ник исполнителя взят из телеграма");
}

async function linkByCode(
  chatId: string,
  code: string,
  username: string | undefined,
  log: Log,
): Promise<void> {
  const user = await prisma.user.findFirst({
    where: {
      telegramLinkCode: code.toUpperCase(),
      telegramLinkExpiresAt: { gt: new Date() },
      disabledAt: null,
    },
  });

  if (!user) {
    await trySendMessage(
      chatId,
      "Код не подошёл — он живёт 15 минут. Откройте CRM и запросите новый.",
      log,
    );
    return;
  }

  // Один телеграм — один пользователь. Если этот чат уже был привязан к
  // кому-то другому, старую привязку снимаем: иначе дайджест уедет не тому.
  await prisma.user.updateMany({
    where: { telegramChatId: chatId, id: { not: user.id } },
    data: { telegramChatId: null },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { telegramChatId: chatId, telegramLinkCode: null, telegramLinkExpiresAt: null },
  });

  await auditLink(
    user.id,
    "telegram_link",
    { chatId, previousChatId: user.telegramChatId },
    log,
  );
  await rememberHandle(user.id, username, log);
  log.info({ email: user.email }, "телеграм привязан");
  const next =
    user.role === "admin"
      ? "Счета, сводка, новые проекты и ваши задачи будут приходить сюда."
      : "Команда /today покажет здесь вашу работу, а задачи приходят в общий чат.";
  await trySendMessage(
    chatId,
    `Готово, ${escapeHtml(user.name ?? user.email)}. Чат привязан. ${next}\n\n${HELP}`,
    log,
  );
}

async function handleCommand(
  chatId: string,
  text: string,
  username: string | undefined,
  log: Log,
): Promise<void> {
  // В группах команды приходят как «/today@it_optimization_bot».
  const [rawCommand = "", argument = ""] = text.trim().split(/\s+/, 2);
  const command = rawCommand.split("@", 1)[0]?.toLowerCase() ?? "";

  if (command === "/start") {
    if (argument) {
      // У групп идентификатор отрицательный, как и в `mention`. Привязка в группе дала бы
      // её участникам личную сводку. Код там уже прочитан всеми, поэтому он гаснет: иначе
      // любой из них прислал бы его боту в личку и привязал свой телеграм к чужой учётке.
      if (!isPrivateChat(chatId)) {
        await prisma.user.updateMany({
          where: { telegramLinkCode: argument.toUpperCase() },
          data: { telegramLinkCode: null, telegramLinkExpiresAt: null },
        });
        await trySendMessage(
          chatId,
          "Привязка делается в личном чате с ботом. Этот код больше не действует: запросите в CRM новый и пришлите его сюда лично.",
          log,
        );
        return;
      }
      return linkByCode(chatId, argument, username, log);
    }
    await trySendMessage(
      chatId,
      `Чтобы смотреть сводку здесь, откройте CRM → «Подключить телеграм» и пришлите мне выданный код.\n\n${HELP}`,
      log,
    );
    return;
  }

  // Идентификатор чата нужен, чтобы прописать общий чат в TELEGRAM_TEAM_CHAT_ID.
  // Достать его иначе — значит лезть на сервер за getUpdates, а тот вдобавок
  // возвращает пустоту, пока обновления забирает работающий бот.
  if (command === "/chatid") {
    await trySendMessage(
      chatId,
      `Идентификатор этого чата: <code>${escapeHtml(chatId)}</code>\n\nВпишите его в TELEGRAM_TEAM_CHAT_ID на сервере.`,
      log,
    );
    return;
  }

  const user = await prisma.user.findFirst({
    where: { telegramChatId: chatId },
    include: WITH_MEMBER,
  });

  if (command === "/stop") {
    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: { telegramChatId: null },
      });
      await auditLink(user.id, "telegram_unlink", { reason: "stop" }, log);
    }
    await trySendMessage(
      chatId,
      "Чат отвязан. Вернуть — командой /start с кодом из CRM.",
      log,
    );
    return;
  }

  if (command === "/today") {
    // Общий чат получает общую сводку, кто бы ни спросил: утром туда приходит она же.
    if (chatId === env.TELEGRAM_TEAM_CHAT_ID) {
      const digest = await buildDigest(await teamChatSnapshot(await collectToday()));
      await trySendMessage(chatId, digest ?? NOTHING_BURNS, log);
      return;
    }

    // Старая привязка к группе не должна открывать её участникам сводку учётки.
    if (!isPrivateChat(chatId)) {
      await trySendMessage(chatId, "Сводка доступна в личном чате с ботом.", log);
      return;
    }

    // Бот отвечает любому аккаунту телеграма, поэтому проверка нужна здесь: отключённая
    // учётка до этих данных в CRM не дойдёт. Роль читается на каждой команде, и
    // понижение действует на привязанный чат сразу, как и на сессии.
    const role = user && !user.disabledAt ? user.role : null;
    if (role !== "admin" && role !== "employee") {
      await trySendMessage(chatId, "Сводка доступна только команде.", log);
      return;
    }

    const digest = await buildDigest(
      await collectTodayFor({ id: user!.id, role, memberName: memberNameOf(user!) }),
    );
    await trySendMessage(chatId, digest ?? NOTHING_BURNS, log);
    return;
  }

  await trySendMessage(chatId, HELP, log);
}

export function startBot(log: Log): () => Promise<void> {
  const controller = new AbortController();
  let offset = 0;

  async function poll(): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        const updates = await callBotApi<TelegramUpdate[]>(
          "getUpdates",
          { offset, timeout: 30, allowed_updates: ["message"] },
          controller.signal,
          // Длинный опрос держит соединение 30 секунд намеренно, поэтому свой
          // таймаут должен быть заведомо больше — иначе он обрывал бы каждый
          // цикл ожидания.
          45_000,
        );

        for (const update of updates) {
          offset = update.update_id + 1;
          const text = update.message?.text;
          const chatId = update.message?.chat.id;
          if (!text || chatId === undefined) continue;

          const username = update.message?.from?.username;
          await handleCommand(String(chatId), text, username, log).catch(
            (cause: unknown) => {
              log.error({ err: cause }, "ошибка обработки сообщения бота");
            },
          );
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        log.warn({ err: cause }, "опрос телеграма сорвался, повтор через 5 секунд");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  void poll();
  log.info(
    { digestAt: env.DIGEST_TIME, timeZone: env.TIMEZONE },
    "бот уведомлений запущен",
  );

  return async () => {
    controller.abort();
  };
}
