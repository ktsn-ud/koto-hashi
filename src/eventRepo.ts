import { prisma } from './prisma.ts';
import { withDbRetry } from './dbRetry.ts';

/**
 * 新しいイベントを登録する（重複時は無視）
 * @param row イベントデータ
 */
export async function upsertNewEvent(row: {
  webhookEventId: string;
  lineTimestampMs: number;
  eventType: string;
  sourceUserId: string | null;
  replyToken: string | null;
  messageText: string | null;
  messageId: string | null;
}) {
  const now = new Date();
  await withDbRetry(() =>
    prisma.lineWebhookEvent.upsert({
      where: { webhookEventId: row.webhookEventId },
      create: {
        webhookEventId: row.webhookEventId,
        status: 'RECEIVED',
        receivedAt: now,
        lineTimestampMs: row.lineTimestampMs,
        eventType: row.eventType,
        sourceUserId: row.sourceUserId,
        replyToken: row.replyToken,
        messageText: row.messageText,
        messageId: row.messageId,
        nextTryAt: now,
      },
      update: {}, // 重複時は何もしない
    })
  );
}
