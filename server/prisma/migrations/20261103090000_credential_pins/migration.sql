-- CreateTable
CREATE TABLE "credential_pins" (
    "user_id" UUID NOT NULL,
    "credential_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_pins_pkey" PRIMARY KEY ("user_id","credential_id")
);

-- CreateIndex
CREATE INDEX "credential_pins_credential_id_idx" ON "credential_pins"("credential_id");

-- AddForeignKey
ALTER TABLE "credential_pins" ADD CONSTRAINT "credential_pins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_pins" ADD CONSTRAINT "credential_pins_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
