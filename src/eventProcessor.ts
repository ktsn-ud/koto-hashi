/**
 * LINE webhookイベントを処理するモジュール
 */

import type { LineWebhookEvent } from '@prisma/client';
import { HTTPFetchError } from '@line/bot-sdk';
import {
  fetchDueEvents,
  claimEventForProcessing,
  markEventDone,
  markEventIgnored,
  markEventRetryableFailure,
  markEventTerminalFailure,
} from './eventRepo.ts';

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;

let activeRun: Promise<void> | null = null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type TextEventHandler = (args: {
  replyToken: string;
  quoteToken: string;
  messageText: string;
  sourceUserId: string | null;
}) => Promise<void>;

/**
 * 一度だけイベント処理を実行する
 * イベントの数はBATCH_SIZEまで処理する
 * @param handleTextEvent テキストメッセージイベントの処理関数
 */
export function runProcessorOnce(
  handleTextEvent: TextEventHandler
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
        const result = await processEvent(event, handleTextEvent);

        if (result.type === 'ignored') {
          await markEventIgnored(event.id, result.reason);
        } else {
          await markEventDone(event.id);
        }
      } catch (err) {
        const message = toErrorMessage(err);

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
 * Processorがアイドル状態になるまで待機する
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

async function processEvent(
  event: LineWebhookEvent,
  handleTextEvent: TextEventHandler
): Promise<{ type: 'done' } | { type: 'ignored'; reason: string }> {
  if (event.eventType !== 'message') {
    return {
      type: 'ignored',
      reason: `Unsupported event type: ${event.eventType}`,
    };
  }

  if (!event.messageText) {
    return { type: 'ignored', reason: 'No message text' };
  }

  if (!event.replyToken) {
    return { type: 'ignored', reason: 'No reply token' };
  }

  if (!event.quoteToken) {
    return { type: 'ignored', reason: 'No quote token' };
  }

  await handleTextEvent({
    replyToken: event.replyToken,
    quoteToken: event.quoteToken,
    messageText: event.messageText,
    sourceUserId: event.sourceUserId,
  });

  return { type: 'done' };
}

export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof TerminalError) return false;
  if (err instanceof HTTPFetchError) {
    const status = err.status;
    return status === 0 || status === 408 || status >= 500;
  }

  return true;
}

function calcNextTryAt(attempt: number): Date {
  const delayMs = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
  return new Date(Date.now() + delayMs);
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  } else {
    return String(err);
  }
}
