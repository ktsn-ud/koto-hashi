import { prisma } from './prisma.ts';
import { withDbRetry } from './dbRetry.ts';

const LOG_RETENTION_DAYS = 30;
const EVENT_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export async function cleanupOldLogsAndEvents() {
  const now = new Date();
  const logCutoff = new Date(now.getTime() - LOG_RETENTION_DAYS * DAY_MS);
  const eventCutoff = new Date(now.getTime() - EVENT_RETENTION_DAYS * DAY_MS);

  // 古いLINE APIリクエストログを削除
  const apiRequestLogDeletedResult = await withDbRetry(() =>
    prisma.lineApiRequestLog.deleteMany({
      where: {
        occurredAt: { lt: logCutoff },
      },
    })
  );

  // 古いLINE Webhookログを削除
  const webhookLogDeletedResult = await withDbRetry(() =>
    prisma.lineWebhookLog.deleteMany({
      where: {
        occurredAt: { lt: logCutoff },
      },
    })
  );

  // 古いLINE Webhookイベントを削除
  const webhookEventDeletedResult = await withDbRetry(() =>
    prisma.lineWebhookEvent.deleteMany({
      where: {
        receivedAt: { lt: eventCutoff },
        status: { in: ['DONE', 'IGNORED', 'FAILED_TERMINAL'] },
      },
    })
  );

  console.log(
    `[Cleanup] Deleted ${apiRequestLogDeletedResult.count} API request logs, ${webhookLogDeletedResult.count} webhook logs, ${webhookEventDeletedResult.count} webhook events.`
  );
}
