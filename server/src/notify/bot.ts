import type { Prisma } from "@prisma/client";
import { WITH_MEMBER } from "../auth/session.js";
import { memberNameOf } from "../crm/access.js";
import { collectToday, personalSnapshot, unassignedSnapshot } from "../crm/today.js";
import { prisma } from "../db.js";
import { canIntake, env } from "../env.js";
import { buildDigest } from "./digest.js";
import { myTasksMessage } from "./my-tasks.js";
import { consumePending } from "./pending.js";
import { handleTaskAction, isTaskAction } from "./task-actions.js";
import { handleCardAction } from "./intake/cards.js";
import {
  acceptMessage,
  acceptsMessage,
  isTaskCommand,
  setIdentity,
  stopIntake,
} from "./intake/intake.js";
import { isPrivateChat } from "./notifications.js";
import {
  callBotApi,
  escapeHtml,
  getMe,
  keepWarm,
  setMyCommands,
  setTelegramLog,
  trySendMessage,
  type TgCallbackQuery,
  type TgMessage,
} from "./telegram.js";

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
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** Без ключа Replicate этой части нет, и справка о ней молчит. */
const INTAKE_HELP = canIntake
  ? [
      "<b>Поставить задачу</b> — просто напишите, перешлите или наговорите голосом:",
      "«Фиксы по кошельку Камилю до пятницы». Я заведу задачу в CRM с исполнителем,",
      "проектом и сроком и пришлю карточку с кнопкой «Отменить».",
      "В общем чате — /task текст, ответ командой /task на чужое сообщение или ответ на мою карточку.",
      "",
    ]
  : [];

const HELP = [
  "Я напоминаю о задачах и сроках — каждому лично о его работе.",
  "",
  ...INTAKE_HELP,
  "<b>/tasks</b> — все ваши открытые задачи",
  ...(canIntake ? ["<b>/task</b> текст — поставить задачу"] : []),
  "<b>/today</b> — что горит прямо сейчас",
  "<b>/chatid</b> — идентификатор этого чата",
  "<b>/stop</b> — отвязать этот чат от учётки",
  "",
  "Каждое утро пишу каждому лично его просроченное и задачи на сегодня,",
  "а в общий чат — задачи без исполнителя.",
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
      ? "Утренняя сводка по вашим задачам и деньгам, счета, новые проекты и ваши задачи будут приходить сюда."
      : "Утренняя сводка по вашим задачам, новые задачи и напоминания о сроках будут приходить сюда.";
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

  if (command === "/tasks") {
    // Список личный: в группе его увидели бы все, а там сидят и те, кому он не нужен.
    if (!isPrivateChat(chatId)) {
      await trySendMessage(chatId, "Свои задачи я показываю в личном чате.", log);
      return;
    }
    // Та же проверка, что у /today: бот отвечает любому аккаунту телеграма.
    const role = user && !user.disabledAt ? user.role : null;
    if (role !== "admin" && role !== "employee") {
      await trySendMessage(
        chatId,
        "Задачи доступны только команде. Подключите бота: CRM → Настройки → «Подключить телеграм».",
        log,
      );
      return;
    }
    const list = await myTasksMessage({
      id: user!.id,
      role,
      memberName: memberNameOf(user!),
    });
    await trySendMessage(chatId, list.text, log, 3, list.keyboard);
    return;
  }

  if (command === "/today") {
    // В общем чате — то же, что туда приходит утром: только ничьи задачи. Своё каждый
    // смотрит в личке, где сводка его собственная.
    if (chatId === env.TELEGRAM_TEAM_CHAT_ID) {
      const digest = await buildDigest(unassignedSnapshot(await collectToday()));
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

    // Та же сводка, что приходит утром: свои задачи и проекты, админу ещё деньги.
    const digest = await buildDigest(
      await personalSnapshot({ id: user!.id, role, memberName: memberNameOf(user!) }),
    );
    await trySendMessage(chatId, digest ?? NOTHING_BURNS, log);
    return;
  }

  await trySendMessage(chatId, HELP, log);
}

/**
 * Меню бота — кнопка у поля ввода со списком команд. В личке — своё: задачи, сводка,
 * постановка. В группе — то, что имеет смысл при всех: личные списки там не показываются.
 */
const PRIVATE_COMMANDS = [
  { command: "tasks", description: "Мои задачи" },
  { command: "today", description: "Что горит сегодня" },
  ...(canIntake ? [{ command: "task", description: "Поставить задачу" }] : []),
  { command: "help", description: "Что умеет бот" },
  { command: "stop", description: "Отвязать этот чат от учётки" },
];

const GROUP_COMMANDS = [
  ...(canIntake
    ? [
        {
          command: "task",
          description: "Поставить задачу: /task текст или ответом на сообщение",
        },
      ]
    : []),
  { command: "today", description: "Сводка команды" },
  { command: "chatid", description: "Идентификатор этого чата" },
];

/**
 * Меню ставится при каждом старте: список зависит от того, включён ли разбор задач, и
 * правка в коде доезжает до телеграма сама, без похода в @BotFather. Сбой здесь опрос не
 * останавливает: бот без меню хуже, чем бот, но лучше, чем никакого.
 */
async function registerCommands(log: Log): Promise<boolean> {
  try {
    await setMyCommands(PRIVATE_COMMANDS, "all_private_chats");
    await setMyCommands(GROUP_COMMANDS, "all_group_chats");
    return true;
  } catch (cause) {
    log.warn({ err: cause }, "меню команд бота не обновилось");
    return false;
  }
}

/**
 * `/task` без текста — так он приходит, когда команду нажали в меню. Разбирать нечего, но
 * молчать нельзя: человек не поймёт, что дальше. Ответом на сообщение в чате голая
 * команда — это «сделай задачу из этого», её разбирает общий путь.
 */
function isBareTask(message: TgMessage): boolean {
  const text = message.text?.trim() ?? "";
  return (
    /^\/task(@\w+)?$/i.test(text) && isTaskCommand(text) && !message.reply_to_message
  );
}

const TASK_HINT_PRIVATE =
  "Просто напишите, что сделать и кому, например: «Фиксы по кошельку Камилю до пятницы». Можно переслать сообщение или записать голосовое.";
const TASK_HINT_GROUP =
  "Напишите задачу после команды: /task Фиксы по кошельку Камилю до пятницы. Или ответьте командой /task на сообщение, из которого нужна задача.";

async function handleUpdate(update: TelegramUpdate, log: Log): Promise<void> {
  // Кнопки карточек работают и без Replicate: им нужна только база.
  if (update.callback_query) {
    return isTaskAction(update.callback_query.data)
      ? handleTaskAction(update.callback_query, log)
      : handleCardAction(update.callback_query, log);
  }

  const message = update.message;
  if (!message) return;
  const chatId = String(message.chat.id);
  const text = message.text;
  const command = text?.startsWith("/") && !isTaskCommand(text);

  // Ответ на «Когда срок?» или «Пришлите файл» — первым: иначе «до ноября» в личке
  // стало бы новой задачей.
  if (await consumePending(message, log)) return;

  if (canIntake && isBareTask(message)) {
    const hint = isPrivateChat(chatId) ? TASK_HINT_PRIVATE : TASK_HINT_GROUP;
    await trySendMessage(chatId, hint, log);
    return;
  }

  // Разбор занимает секунды, поэтому идёт в фоне: опрос не ждёт его и не держит кнопки.
  if (canIntake && !command && acceptsMessage(message)) {
    acceptMessage(message, log);
    return;
  }

  if (!text) return;
  // Обычная переписка в группе бота не касается: там он отвечает только на команды. Иначе
  // с выключенной приватностью он отвечал бы справкой на каждое сообщение чата.
  if (!isPrivateChat(chatId) && !text.startsWith("/")) return;
  await handleCommand(chatId, text, message.from?.username, log);
}

/** Чей это апдейт: человек в конкретном чате. */
function senderOf(update: TelegramUpdate): string {
  const query = update.callback_query;
  if (query) return `${query.message?.chat.id ?? query.from.id}:${query.from.id}`;
  const message = update.message;
  return `${message?.chat.id ?? 0}:${message?.from?.id ?? 0}`;
}

/** Что за апдейт — для журнала о медленной обработке, без текста сообщения. */
function kindOf(update: TelegramUpdate): string {
  const data = update.callback_query?.data;
  if (data) return `кнопка ${data.split(":").slice(0, 2).join(":")}`;
  return update.message?.text?.startsWith("/") ? "команда" : "сообщение";
}

/** Дольше этого обработка апдейта попадает в журнал: так видно, где бот тормозит. */
const SLOW_UPDATE_MS = 3_000;

export function startBot(log: Log): () => Promise<void> {
  const controller = new AbortController();
  let offset = 0;
  let knowsSelf = !canIntake;
  let menuAttempts = 0;
  let menuReady = false;
  setTelegramLog(log);
  const stopWarm = keepWarm();

  /**
   * Апдейты обрабатываются параллельно, а не по одному: раньше опрос ждал каждый, и одно
   * долгое действие (разбор срока моделью, повтор отправки) держало кнопки всех остальных.
   * Порядок сохраняется внутри одного человека в одном чате: ответ на «Когда срок?» должен
   * прийти после самого вопроса, а второе нажатие — после первого.
   */
  const queues = new Map<string, Promise<void>>();
  function dispatch(update: TelegramUpdate): void {
    const key = senderOf(update);
    const run = async () => {
      const started = Date.now();
      await handleUpdate(update, log).catch((cause: unknown) => {
        log.error({ err: cause }, "ошибка обработки сообщения бота");
      });
      const took = Date.now() - started;
      if (took > SLOW_UPDATE_MS) {
        log.warn({ kind: kindOf(update), ms: took }, "бот долго обрабатывал апдейт");
      }
    };
    const next = (queues.get(key) ?? Promise.resolve()).then(run);
    queues.set(key, next);
    void next.then(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  }

  async function poll(): Promise<void> {
    while (!controller.signal.aborted) {
      try {
        // Своё имя нужно, чтобы узнать обращение в общем чате. Спрашивается в цикле: при
        // старте телеграм бывает недоступен, а бот без этого не должен вставать.
        if (!knowsSelf) {
          setIdentity(await getMe());
          knowsSelf = true;
        }
        // Несколько попыток, а не вечные: неудача тут не мешает работе, а лог засорила бы.
        if (!menuReady && menuAttempts < 5) {
          menuAttempts += 1;
          menuReady = await registerCommands(log);
        }

        const updates = await callBotApi<TelegramUpdate[]>(
          "getUpdates",
          { offset, timeout: 30, allowed_updates: ["message", "callback_query"] },
          controller.signal,
          // Длинный опрос держит соединение 30 секунд намеренно, поэтому свой
          // таймаут должен быть заведомо больше — иначе он обрывал бы каждый
          // цикл ожидания.
          45_000,
        );

        for (const update of updates) {
          offset = update.update_id + 1;
          dispatch(update);
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
    stopWarm();
    // Начатые нажатия доделываем, но не дольше 10 секунд: остановку они не держат.
    await Promise.race([
      Promise.allSettled([...queues.values()]),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    await stopIntake();
  };
}
