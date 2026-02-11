import { prisma } from './prisma.ts';
import { withDbRetry } from './dbRetry.ts';

export async function insertLineApiRequestLog(row: {
  occurredAt: Date;
  xLineRequestId: string;
  httpMethod: string;
  apiEndpoint: string;
  lineStatusCode: number;
}) {
  await withDbRetry(() =>
    prisma.lineApiRequestLog.create({
      data: {
        occurredAt: row.occurredAt,
        xLineRequestId: row.xLineRequestId,
        httpMethod: row.httpMethod,
        apiEndpoint: row.apiEndpoint,
        lineStatusCode: row.lineStatusCode,
      },
    })
  );
}

export async function insertLineWebhookLog(row: {
  occurredAt: Date;
  senderIp: string;
  requestPath: string;
  serverStatusCode: number;
  webhookHttpMethod: string;
}) {
  await withDbRetry(() =>
    prisma.lineWebhookLog.create({
      data: {
        occurredAt: row.occurredAt,
        senderIp: row.senderIp,
        requestPath: row.requestPath,
        serverStatusCode: row.serverStatusCode,
        webhookHttpMethod: row.webhookHttpMethod,
      },
    })
  );
}
