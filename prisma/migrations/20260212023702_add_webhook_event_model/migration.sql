-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'DONE', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'IGNORED');

-- CreateTable
CREATE TABLE "LineWebhookEvent" (
    "id" STRING NOT NULL,
    "webhookEventId" STRING NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lineTimestampMs" INT8 NOT NULL,
    "eventType" STRING NOT NULL,
    "sourceUserId" STRING,
    "replyToken" STRING,
    "messageText" STRING,
    "messageId" STRING,
    "attemptCount" INT4 NOT NULL DEFAULT 0,
    "lastErrorMessage" STRING,
    "nextTryAt" TIMESTAMP(3),

    CONSTRAINT "LineWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LineWebhookEvent_webhookEventId_key" ON "LineWebhookEvent"("webhookEventId");

-- CreateIndex
CREATE INDEX "LineWebhookEvent_status_nextTryAt_idx" ON "LineWebhookEvent"("status", "nextTryAt");

-- CreateIndex
CREATE INDEX "LineWebhookEvent_receivedAt_idx" ON "LineWebhookEvent"("receivedAt");
