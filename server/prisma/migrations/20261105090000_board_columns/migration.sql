-- Колонки досок: название и порядок задаёт админ, тип колонки — статус её карточек.
-- Схему только дополняет. Данные меняет в одном: «Когда-нибудь» убрано, такие задачи
-- переходят в конец «К работе». Откат API этого не возвращает, старый код просто не
-- видит колонок.

-- CreateTable
CREATE TABLE "board_columns" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_columns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "board_columns_scope_position_idx" ON "board_columns"("scope", "position");

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "column_id" UUID;
ALTER TABLE "tasks" ADD COLUMN "column_id" UUID;

-- CreateIndex
CREATE INDEX "projects_column_id_position_idx" ON "projects"("column_id", "position");
CREATE INDEX "tasks_column_id_position_idx" ON "tasks"("column_id", "position");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_column_id_fkey" FOREIGN KEY ("column_id") REFERENCES "board_columns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_column_id_fkey" FOREIGN KEY ("column_id") REFERENCES "board_columns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Колонки по умолчанию. «На проверке» — замена «Когда-нибудь»: тот же тип, что
-- «В работе», для системы задача там ещё в работе.
INSERT INTO "board_columns" ("id", "scope", "title", "kind", "position") VALUES
  (gen_random_uuid(), 'task', 'К работе', 'todo', 0),
  (gen_random_uuid(), 'task', 'В работе', 'in_progress', 1),
  (gen_random_uuid(), 'task', 'На проверке', 'in_progress', 2),
  (gen_random_uuid(), 'task', 'Готово', 'done', 3),
  (gen_random_uuid(), 'project', 'Запланирован', 'planned', 0),
  (gen_random_uuid(), 'project', 'В работе', 'active', 1),
  (gen_random_uuid(), 'project', 'На паузе', 'on_hold', 2),
  (gen_random_uuid(), 'project', 'Сдан', 'done', 3),
  (gen_random_uuid(), 'project', 'Отменён', 'cancelled', 4);

-- «Когда-нибудь»: в конец «К работе», порядок между собой сохраняется.
UPDATE "tasks"
SET "position" = "position" + (
  SELECT coalesce(max("position"), -1) + 1 FROM "tasks"
  WHERE "status" = 'todo' AND "parent_id" IS NULL
)
WHERE "status" = 'backlog' AND "parent_id" IS NULL;
UPDATE "tasks" SET "status" = 'todo' WHERE "status" = 'backlog';

-- Каждая карточка — в первую колонку своего статуса. Подзадачи на доске не бывают.
UPDATE "tasks" t SET "column_id" = c."id"
FROM "board_columns" c
WHERE t."parent_id" IS NULL
  AND c."scope" = 'task' AND c."kind" = t."status"::text
  AND c."position" = (
    SELECT min(c2."position") FROM "board_columns" c2
    WHERE c2."scope" = 'task' AND c2."kind" = c."kind"
  );

UPDATE "projects" p SET "column_id" = c."id"
FROM "board_columns" c
WHERE c."scope" = 'project' AND c."kind" = p."status"::text
  AND c."position" = (
    SELECT min(c2."position") FROM "board_columns" c2
    WHERE c2."scope" = 'project' AND c2."kind" = c."kind"
  );
