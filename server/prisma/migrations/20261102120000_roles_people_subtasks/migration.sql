-- Две роли, люди вместо зашитого списка, подзадачи.
--
-- Весь файл уходит одним запросом и потому выполняется одной транзакцией: упав на
-- середине, он не оставит ни колонок, ни заметок, ни сменённых ролей.
--
-- Только добавляет: enum не меняется, `tasks.description` остаётся на месте, старый API
-- этих колонок не замечает. Откат API на прежний образ SQL не требует. Роли при этом
-- останутся новыми: это данные, а не схема.
--
-- Повторный запуск ничего не меняет: IF NOT EXISTS, проверки и NOT EXISTS ниже. В SQL
-- роли старыми значениями (`owner`, `editor`), потому что в базе они не менялись.
--
-- Первое слово имени считается почти как `trim().split(/\s+/)[0]` в старом коде. Разница
-- одна: `\S` в Postgres считает неразрывный пробел U+00A0 значимым символом, а JS нет, и
-- «Вадим<U+00A0>Иванов» здесь останется одним словом. Предполётный запрос из
-- `docs/deploy.md` такое имя покажет. Сравнение идёт через lower(): «вадим» и «Вадим» —
-- один человек. lower() стоит с обеих сторон, чтобы в базе с локалью C, где кириллица не
-- складывается, остался точный поиск.

-- 1. Колонки.
ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "user_id" UUID,
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "parent_id" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "team_members_user_id_key" ON "team_members"("user_id");
CREATE INDEX IF NOT EXISTS "tasks_parent_id_idx" ON "tasks"("parent_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_members_user_id_fkey') THEN
    ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_parent_id_fkey') THEN
    ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_fkey"
      FOREIGN KEY ("parent_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 2. Описания задач в заметки: поле «Подробности» уходит из формы, а текст не должен
-- исчезнуть с экрана. Удалённые задачи тоже: из корзины они вернутся с описанием в
-- заметках. Колонка `description` не чистится, она запас на откат API.
INSERT INTO "notes" ("id", "entity", "entity_id", "body", "author_id", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  'task',
  t."id",
  btrim(t."description", E' \t\r\n'),
  t."created_by_id",
  t."created_at",
  t."created_at"
FROM "tasks" t
WHERE t."description" ~ '\S'
  AND NOT EXISTS (
    SELECT 1 FROM "notes" n
    WHERE n."entity" = 'task'
      AND n."entity_id" = t."id"
      AND n."body" = btrim(t."description", E' \t\r\n')
  );

-- 3. Люди. Раньше список жил в коде, а строка в таблице появлялась только с ником.
INSERT INTO "team_members" ("name", "updated_at")
VALUES
  ('Егор', CURRENT_TIMESTAMP),
  ('Вадим', CURRENT_TIMESTAMP),
  ('Камиль', CURRENT_TIMESTAMP),
  ('Тимур', CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;

-- Порядок в выборе «Кто делает» идёт по created_at, а у всех четверых он сейчас общий.
-- Дата постоянная, а не текущая: повторный запуск не должен ставить их после тех, кого
-- завели позже.
UPDATE "team_members"
SET "created_at" = TIMESTAMP '2026-08-05 10:00:00'
  + array_position(ARRAY['Егор', 'Вадим', 'Камиль', 'Тимур']::TEXT[], "name") * INTERVAL '1 second'
WHERE "name" IN ('Егор', 'Вадим', 'Камиль', 'Тимур');

-- На одно имя одна учётка: включённые раньше отключённых, старшие раньше.
CREATE TEMP TABLE "people_accounts" ON COMMIT DROP AS
SELECT DISTINCT ON (lower("word")) "id", "word"
FROM (
  SELECT "id", substring("name" FROM '\S+') AS "word", "disabled_at", "created_at"
  FROM "users"
) AS "named"
WHERE "word" IS NOT NULL
ORDER BY lower("word"), ("disabled_at" IS NOT NULL), "created_at", "id";

INSERT INTO "team_members" ("name", "updated_at")
SELECT a."word", CURRENT_TIMESTAMP
FROM "people_accounts" a
WHERE NOT EXISTS (
  SELECT 1 FROM "team_members" m WHERE lower(m."name") = lower(a."word")
)
ON CONFLICT ("name") DO NOTHING;

-- Уже связанного не трогаем: при повторном запуске связь мог поставить администратор.
UPDATE "team_members" m
SET "user_id" = a."id", "updated_at" = CURRENT_TIMESTAMP
FROM "people_accounts" a
WHERE lower(m."name") = lower(a."word")
  AND m."user_id" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "team_members" taken WHERE taken."user_id" = a."id");

-- 4. Роли. Сначала повышение, потом понижение: иначе проверка ниже не увидела бы
-- Вадима и Егора, которые станут владельцами в этом же запуске.
UPDATE "users"
SET "role" = 'owner'
WHERE lower(substring("name" FROM '\S+')) IN (lower('Вадим'), lower('Егор'));

UPDATE "users" SET "role" = 'editor' WHERE "role" = 'marketing';

-- Система без активного владельца из интерфейса не чинится, поэтому Камиль и Тимур
-- понижаются только вместе и только если рядом остаётся кто-то ещё.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "users"
    WHERE "role" = 'owner'
      AND "disabled_at" IS NULL
      AND COALESCE(lower(substring("name" FROM '\S+')), '') NOT IN (lower('Камиль'), lower('Тимур'))
  ) THEN
    UPDATE "users"
    SET "role" = 'editor'
    WHERE lower(substring("name" FROM '\S+')) IN (lower('Камиль'), lower('Тимур'));
  END IF;
END $$;
