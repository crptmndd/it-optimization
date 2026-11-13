-- CreateTable
CREATE TABLE "task_review_messages" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "chat_id" TEXT NOT NULL,
    "message_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_review_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_review_messages_task_id_idx" ON "task_review_messages"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_review_messages_chat_id_message_id_key" ON "task_review_messages"("chat_id", "message_id");

-- AddForeignKey
ALTER TABLE "task_review_messages" ADD CONSTRAINT "task_review_messages_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
