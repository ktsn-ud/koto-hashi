-- AlterTable
ALTER TABLE "LineWebhookEvent" ADD COLUMN     "isMentioned" BOOL;
ALTER TABLE "LineWebhookEvent" ADD COLUMN     "sourceGroupId" STRING;

-- CreateTable
CREATE TABLE "GroupidLanguageMapping" (
    "id" STRING NOT NULL,
    "groupId" STRING NOT NULL,
    "languageCode" STRING NOT NULL,

    CONSTRAINT "GroupidLanguageMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupidLanguageMapping_groupId_key" ON "GroupidLanguageMapping"("groupId");
