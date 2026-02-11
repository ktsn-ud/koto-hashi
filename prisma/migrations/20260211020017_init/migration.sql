-- CreateTable
CREATE TABLE "LineApiRequestLog" (
    "id" STRING NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "xLineRequestId" STRING NOT NULL,
    "httpMethod" STRING NOT NULL,
    "apiEndpoint" STRING NOT NULL,
    "lineStatusCode" INT4 NOT NULL,

    CONSTRAINT "LineApiRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineWebhookLog" (
    "id" STRING NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "senderIp" STRING NOT NULL,
    "requestPath" STRING NOT NULL,
    "serverStatusCode" INT4 NOT NULL,
    "webhookHttpMethod" STRING NOT NULL,

    CONSTRAINT "LineWebhookLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LineApiRequestLog_occurredAt_idx" ON "LineApiRequestLog"("occurredAt");

-- CreateIndex
CREATE INDEX "LineWebhookLog_occurredAt_idx" ON "LineWebhookLog"("occurredAt");
