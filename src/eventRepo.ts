/**
 * LINE webhookイベントのデータベース操作を行うモジュール
 */

import { prisma } from './prisma.ts';
import type { LineWebhookEvent } from '@prisma/client';
import { withDbRetry } from './dbRetry.ts';

const LEASE_TIME_MS = 60_000; // イベント処理のリース時間（処理時間より長く設定）

export interface NewEventRow {
  webhookEventId: string;
  lineTimestampMs: bigint;
  eventType: string;
  sourceUserId: string | null;
  replyToken: string | null;
  quoteToken: string | null;
  messageText: string | null;
  messageId: string | null;
}

/**
 * 新しいイベントをまとめて登録する（重複時は無視）
 * @param rows イベントデータ
 */
export async function insertNewEventsBatch(rows: NewEventRow[]) {
  if (rows.length === 0) return;
  const now = new Date();

  await withDbRetry(() =>
    prisma.lineWebhookEvent.createMany({
      data: rows.map((row) => ({
        webhookEventId: row.webhookEventId,
        status: 'RECEIVED',
        receivedAt: now,
        lineTimestampMs: row.lineTimestampMs,
        eventType: row.eventType,
        sourceUserId: row.sourceUserId,
        replyToken: row.replyToken,
        quoteToken: row.quoteToken,
        messageText: row.messageText,
        messageId: row.messageId,
        nextTryAt: now,
      })),
      skipDuplicates: true,
    })
  );
}

/**
 * 処理待ちのイベントを取得する
 * @param limit 取得上限
 * @param now 現在時刻
 * @return 処理待ちイベントの配列
 */
export async function fetchDueEvents(
  limit: number,
  now = new Date()
): Promise<LineWebhookEvent[]> {
  return withDbRetry(() =>
    prisma.lineWebhookEvent.findMany({
      where: {
        status: { in: ['RECEIVED', 'FAILED_RETRYABLE', 'PROCESSING'] },
        nextTryAt: { lte: now },
      },
      orderBy: [{ nextTryAt: 'asc' }, { lineTimestampMs: 'asc' }],
      take: limit,
    })
  );
}

/**
 * イベントを`PROCESSING`にする
 * @param id レコードのID
 * @param now 現在時刻
 * @return `PROCESSING`にできたらtrue、他のプロセスに取られていたらfalse
 */
export async function claimEventForProcessing(
  id: string,
  now = new Date()
): Promise<boolean> {
  const result = await withDbRetry(() =>
    // RECEIVEDの場合は処理可能
    // FAILED_RETRYABLEの場合は次回試行時刻が来ていれば処理可能
    // PROCESSINGの場合はリース切れなら処理可能
    prisma.lineWebhookEvent.updateMany({
      where: {
        id,
        status: { in: ['RECEIVED', 'FAILED_RETRYABLE', 'PROCESSING'] },
        nextTryAt: { lte: now },
      },
      data: {
        status: 'PROCESSING',
        attemptCount: { increment: 1 },
        nextTryAt: new Date(now.getTime() + LEASE_TIME_MS), // リース時間を設定
      },
    })
  );
  return result.count === 1;
}

/**
 * イベントを`DONE`にする
 * @param id レコードのID
 */
export async function markEventDone(id: string) {
  await withDbRetry(() =>
    prisma.lineWebhookEvent.update({
      where: { id },
      data: {
        status: 'DONE',
        nextTryAt: null,
        lastErrorMessage: null,
      },
    })
  );
}

/**
 * イベントを`IGNORED`にする
 * @param id レコードのID
 * @param reason 無視事由
 */
export async function markEventIgnored(id: string, reason: string) {
  await withDbRetry(() =>
    prisma.lineWebhookEvent.update({
      where: { id },
      data: {
        status: 'IGNORED',
        nextTryAt: null,
        lastErrorMessage: reason,
      },
    })
  );
}

/**
 * イベントを`FAILED_RETRYABLE`にする
 * @param id レコードのID
 * @param message エラーメッセージ
 * @param nextTryAt 次回試行時刻
 */
export async function markEventRetryableFailure(
  id: string,
  message: string,
  nextTryAt: Date
) {
  await withDbRetry(() =>
    prisma.lineWebhookEvent.update({
      where: { id },
      data: {
        status: 'FAILED_RETRYABLE',
        lastErrorMessage: message,
        nextTryAt,
      },
    })
  );
}

/**
 * イベントを`FAILED_TERMINAL`にする
 * @param id レコードのID
 * @param message エラーメッセージ
 */
export async function markEventTerminalFailure(id: string, message: string) {
  await withDbRetry(() =>
    prisma.lineWebhookEvent.update({
      where: { id },
      data: {
        status: 'FAILED_TERMINAL',
        nextTryAt: null,
        lastErrorMessage: message,
      },
    })
  );
}
