import { z } from "zod";

/**
 * Конфигурация читается один раз при старте и валидируется: сервис должен
 * падать сразу и с понятным текстом, а не через час на первом запросе.
 *
 * Сюда попадает то, что уже лежит в `process.env`. В контейнере переменные
 * приходят из `env_file` в docker-compose, локально — из `server/.env`, который
 * подключает флаг `--env-file-if-exists` в npm-скрипте `dev`. Флаг обязателен:
 * сам по себе файл не читается, а Prisma грузит его только ради собственного
 * `DATABASE_URL`. Без флага всё остальное молча уезжает на значения по
 * умолчанию — и, например, `WEB_ORIGIN` из файла просто не действует.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),

  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /**
   * Кому разрешено ходить в API с кукой: сайт (панель кейсов) и CRM на
   * поддомене. Список через запятую — с `credentials` браузер не принимает
   * «*», и каждый origin нужно назвать явно.
   */
  WEB_ORIGIN: z
    .string()
    .min(1)
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().url()).nonempty()),

  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  COOKIE_DOMAIN: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(14),

  UPLOAD_DIR: z.string().default("./uploads"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),

  /**
   * Бот уведомлений. Токен не задан — бот просто не запускается, остальной
   * сервис работает как ни в чём не бывало: напоминания приятны, но API от них
   * не зависит.
   */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /**
   * Адрес Bot API. Меняется, когда до `api.telegram.org` нет прямого хода:
   * некоторые хостеры режут именно его, при этом остальной исходящий HTTPS
   * работает. Тогда сюда прописывается ретранслятор, который пересылает
   * запросы дальше, а код остаётся прежним.
   */
  TELEGRAM_API_BASE: z.string().url().default("https://api.telegram.org"),
  /** Общий чат для сообщений о новых лидах. Пусто — шлём всем подключившимся. */
  TELEGRAM_TEAM_CHAT_ID: z.string().optional(),
  /** Время утреннего дайджеста, ЧЧ:ММ в часовом поясе ниже. */
  DIGEST_TIME: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "ожидается время в формате ЧЧ:ММ")
    .default("09:00"),
  /** Пояс, в котором считаются «сегодня» и время дайджеста. */
  TIMEZONE: z.string().default("Europe/Moscow"),

  /**
   * Ключ паролей и секретов 2FA: 32 байта в base64. Живёт только здесь: в базе и
   * дампах его нет, поэтому утёкший дамп не раскрывает ничего.
   */
  VAULT_KEY: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined)
    .refine((value) => {
      if (!value) return true;
      const key = Buffer.from(value, "base64");
      // Сверка обратным кодированием: Buffer молча пропускает мусор, и фраза из
      // 43 букв прошла бы как ключ на 32 байта.
      return key.length === 32 && key.toString("base64") === value;
    }, "ожидается 32 байта в base64: openssl rand -base64 32"),

  /**
   * Откуда можно открывать пароли. Сайт с панелью тоже стоит в WEB_ORIGIN, но
   * паролей им не нужно. Пусто — проверки нет: так работает локальный запуск.
   */
  CRM_ORIGIN: z
    .string()
    .optional()
    .transform((value) => value?.trim().replace(/\/$/, "") || undefined)
    .pipe(z.string().url().optional()),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_OWNER: z.string().default("crptmndd"),
  GITHUB_REPO: z.string().default("it-optimization"),
  GITHUB_BRANCH: z.string().default("main"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Некорректная конфигурация (server/.env):\n${details}`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";

/** Публикация работает, только если сервису выдан доступ к репозиторию. */
export const canPublish = Boolean(env.GITHUB_TOKEN);

/** Бот поднимается, только если выдан токен. */
export const canNotify = Boolean(env.TELEGRAM_BOT_TOKEN);

if (isProduction && !env.COOKIE_SECURE) {
  // Не падаем: бывает деплой за доверенным прокси, который сам держит TLS.
  console.warn(
    "[config] NODE_ENV=production, но COOKIE_SECURE=false — сессионная кука уйдёт по HTTP.",
  );
}
