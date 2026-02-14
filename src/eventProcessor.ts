/**
 * LINE webhookイベントを処理するモジュール
 */

import type { LineWebhookEvent } from '@prisma/client';
import { HTTPFetchError } from '@line/bot-sdk';
import {
  fetchDueEvents,
  claimEventForProcessing,
  hasUnsendEventForMessageId,
  markEventDone,
  markEventIgnored,
  markEventRetryableFailure,
  markEventTerminalFailure,
} from './eventRepo.ts';

const BATCH_SIZE = 50; // 一度に処理するイベントの最大数
const MAX_ATTEMPTS = 5; // 最大試行回数

// 実行を追跡しておく（シャットダウン時に待つため）
let activeRun: Promise<void> | null = null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type TextEventHandler = (args: {
  replyToken: string;
  quoteToken: string;
  messageText: string;
  sourceUserId: string | null;
  sourceGroupId: string | null;
}) => Promise<void>;

type UnsendEventHandler = (args: { messageId: string }) => Promise<void>;

type LanguageRegistrationHandler = (args: {
  sourceUserId: string | null;
  replyToken: string;
  quoteToken: string;
  groupId: string;
  messageText: string;
}) => Promise<void>;

/**
 * 処理可能なイベントを1バッチだけ実行する。
 *
 * この関数がやること:
 * - DBから対象イベントを取得する (`fetchDueEvents`)
 * - claimで処理権を獲得する (`claimEventForProcessing`)
 * - イベントを処理する (`processEvent`)
 * - 結果に応じてDBの状態を更新する（`markEvent****`）
 *
 * この関数がやらないこと:
 * - Webhook受信やHTTPレスポンス
 *
 * @param handleTextEvent テキストメッセージイベントの処理関数
 * @param handleUnsendEvent 送信取消イベントの処理関数
 * @param handleLanguageRegistration 言語登録イベントの処理関数
 */
export function runProcessorOnce(
  handleTextEvent: TextEventHandler,
  handleUnsendEvent: UnsendEventHandler,
  handleLanguageRegistration: LanguageRegistrationHandler
): Promise<void> {
  if (activeRun) {
    return activeRun;
  }

  activeRun = (async () => {
    const now = new Date();
    const events = await fetchDueEvents(BATCH_SIZE, now);

    for (const event of events) {
      const claimed = await claimEventForProcessing(event.id, now);
      if (!claimed) continue; // 他のプロセスが先に処理権を取った

      const currentAttempt = event.attemptCount + 1;

      try {
        // イベントを処理する
        const result = await processEvent(
          event,
          handleTextEvent,
          handleUnsendEvent,
          handleLanguageRegistration
        );

        // 処理結果をDBに反映
        if (result.type === 'ignored') {
          await markEventIgnored(event.id, result.reason);
        } else {
          await markEventDone(event.id);
        }
      } catch (err) {
        const message = toErrorMessage(err);

        // 条件に応じて再試行 or 終了
        if (currentAttempt >= MAX_ATTEMPTS || !isRetryableError(err)) {
          await markEventTerminalFailure(event.id, message);
          continue;
        }

        const nextTryAt = calcNextTryAt(currentAttempt);
        await markEventRetryableFailure(event.id, message, nextTryAt);
      }
    }
  })().finally(() => {
    activeRun = null;
  });

  return activeRun;
}

/**
 * Processorがアイドル状態になるまで待機する。
 * 主にshutdown時に、進行中の処理が終わるのを待つために使う。
 *
 * @param timeoutMs タイムアウト時間（ミリ秒）
 * @returns アイドルになったらtrue、タイムアウト時はfalse
 */
export async function waitForProcessorIdle(
  timeoutMs = 5_000
): Promise<boolean> {
  if (!activeRun) {
    return true;
  }

  const done = activeRun.then(
    () => true,
    () => true
  );
  const timeout = sleep(timeoutMs).then(() => false);
  return Promise.race([done, timeout]);
}

/**
 * 1件のイベントを処理し、結果（done/ignored）を返す。
 *
 * この関数がやること:
 * - 対応外イベントの判定（ignored）
 * - 必須フィールド不足の判定（ignored）
 * - `handleTextEvent`の呼び出し
 *
 * この関数がやらないこと:
 * - DB状態更新（DONE/FAILEDなど）は行わない
 *
 * @param event 処理するイベント
 * @param handleTextEvent テキストメッセージイベントの処理関数
 * @param handleUnsendEvent 送信取消イベントの処理関数
 * @param handleLanguageRegistration 言語登録イベントの処理関数
 * @return done または ignored を表すオブジェクト
 */
async function processEvent(
  event: LineWebhookEvent,
  handleTextEvent: TextEventHandler,
  handleUnsendEvent: UnsendEventHandler,
  handleLanguageRegistration: LanguageRegistrationHandler
): Promise<{ type: 'done' } | { type: 'ignored'; reason: string }> {
  switch (event.eventType) {
    case 'message':
      if (!event.messageId) {
        return { type: 'ignored', reason: 'No message ID' };
      }

      // 先にunsendが到着済みなら返信せずマスクだけ実施する
      const hasUnsendEvent = await hasUnsendEventForMessageId(event.messageId);
      if (hasUnsendEvent) {
        await handleUnsendEvent({ messageId: event.messageId });
        return {
          type: 'ignored',
          reason: `Message already unsent: ${event.messageId}`,
        };
      }

      if (!event.messageText) {
        return { type: 'ignored', reason: 'No message text' };
      }

      if (!event.replyToken) {
        return { type: 'ignored', reason: 'No reply token' };
      }

      // messageTextがあればquoteTokenもあるはずだが念のため確認
      if (!event.quoteToken) {
        return { type: 'ignored', reason: 'No quote token' };
      }

      // bot がメンションされている場合は言語登録イベントとして処理する
      if (event.isMentioned) {
        if (!event.sourceGroupId) {
          return {
            type: 'ignored',
            reason: 'No source group ID for mentioned message',
          };
        }

        await handleLanguageRegistration({
          sourceUserId: event.sourceUserId,
          replyToken: event.replyToken,
          quoteToken: event.quoteToken,
          groupId: event.sourceGroupId,
          messageText: event.messageText,
        });

        return { type: 'done' };
      }

      // そうでない場合は通常のテキストイベントとして処理する
      await handleTextEvent({
        replyToken: event.replyToken,
        quoteToken: event.quoteToken,
        messageText: event.messageText,
        sourceUserId: event.sourceUserId,
        sourceGroupId: event.sourceGroupId,
      });

      return { type: 'done' };

    case 'unsend':
      if (!event.messageId) {
        return { type: 'ignored', reason: 'No message ID' };
      }

      await handleUnsendEvent({
        messageId: event.messageId,
      });

      return { type: 'done' };

    default:
      return {
        type: 'ignored',
        reason: `Unsupported event type: ${event.eventType}`,
      };
  }
}

/**
 * 「再試行しない失敗」を表すエラー。
 * `runProcessorOnce`はこのエラーを受け取ると`FAILED_TERMINAL`にする。
 */
export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

/**
 * エラーが再試行可能かどうかを判定する。
 *
 * この関数がやること:
 * - 失敗を「再試行する/しない」に分ける
 *
 * この関数がやらないこと:
 * - 次回実行時刻の計算
 * - DB更新
 *
 * @param err 判定するエラー
 * @return 再試行可能ならtrue、そうでなければfalse
 */
function isRetryableError(err: unknown): boolean {
  if (err instanceof TerminalError) return false;
  if (err instanceof HTTPFetchError) {
    const status = err.status;
    return status === 0 || status === 408 || status >= 500;
  }

  return true;
}

/**
 * 次回試行時刻を計算する（指数バックオフ）。
 *
 * @param attempt 試行回数（1から始まる）
 * @return 次回試行時刻
 */
function calcNextTryAt(attempt: number): Date {
  const delayMs = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
  return new Date(Date.now() + delayMs);
}

/**
 * エラーメッセージをstringとして取得する
 *
 * @param err エラーオブジェクト
 * @return エラーメッセージ
 */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  } else {
    return String(err);
  }
}
