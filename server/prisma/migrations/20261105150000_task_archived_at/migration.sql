-- Ручной архив задач: отметка админа. Только добавляет колонку, данные не трогает.
-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "archived_at" TIMESTAMP(3);
