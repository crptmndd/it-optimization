-- CRM: архив проектов, этапы договоров, команда, 2FA и пароли на серверном ключе.
-- Миграция только добавляет: act_date, secret_hint, secret, leads и invoices не
-- меняются, поэтому откат API не требует отката базы.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "totp_enabled_at" TIMESTAMP(3),
ADD COLUMN     "totp_failed_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totp_last_step" INTEGER,
ADD COLUMN     "totp_locked_until" TIMESTAMP(3),
ADD COLUMN     "totp_secret_enc" TEXT;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "two_factor_confirmed_until" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "archived_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "credentials" ADD COLUMN     "password_enc" TEXT,
ADD COLUMN     "secret_migrated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "login_tickets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "name" TEXT NOT NULL,
    "telegram_username" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "project_stages" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "amount_minor" INTEGER,
    "currency" "Currency" NOT NULL DEFAULT 'rub',
    "issued_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_stages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "login_tickets_token_hash_key" ON "login_tickets"("token_hash");

-- CreateIndex
CREATE INDEX "login_tickets_user_id_idx" ON "login_tickets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_codes_user_id_code_hash_key" ON "recovery_codes"("user_id", "code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "project_stages_project_id_position_key" ON "project_stages"("project_id", "position");

-- CreateIndex
CREATE INDEX "projects_archived_at_idx" ON "projects"("archived_at");

-- AddForeignKey
ALTER TABLE "login_tickets" ADD CONSTRAINT "login_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Позиция этапа: их ровно три. Prisma таких проверок не описывает, но и не
-- считает расхождением, поэтому ограничение живёт только здесь.
ALTER TABLE "project_stages"
  ADD CONSTRAINT "project_stages_position_check" CHECK ("position" BETWEEN 1 AND 3);

-- Этапы уже существующих договорных проектов. Удалённые мягко тоже: проект
-- могут вернуть из корзины, и он должен прийти с этапами. Сумм нет — их никто не
-- называл; валюта берётся у проекта.
INSERT INTO "project_stages" ("id", "project_id", "position", "currency", "updated_at")
SELECT gen_random_uuid(), p."id", stage.position, p."currency", CURRENT_TIMESTAMP
FROM "projects" p
CROSS JOIN generate_series(1, 3) AS stage(position)
WHERE p."work_type" = 'contract';

-- Поле «Где пароль» уходит из интерфейса, но текст терять нельзя: он дописывается
-- в заметки. Колонка secret_hint остаётся нетронутой. Символы для btrim перечислены
-- явно: без них он режет только пробелы, и подсказка из таба или перевода строки
-- дала бы в заметках пустую строку «Где пароль:».
UPDATE "credentials"
SET "notes" = CASE
    WHEN "notes" IS NULL OR btrim("notes", E' \t\r\n') = ''
      THEN 'Где пароль: ' || btrim("secret_hint", E' \t\r\n')
    ELSE "notes" || E'\n' || 'Где пароль: ' || btrim("secret_hint", E' \t\r\n')
  END
WHERE "secret_hint" IS NOT NULL AND btrim("secret_hint", E' \t\r\n') <> '';
