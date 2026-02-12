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

let running = false;

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
export async function runProcessorOnce(handleTextEvent: TextEventHandler) {
  if (running) return;
  running = true;

  try {
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
  } finally {
    running = false;
  }
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

class TerminalError extends Error {}

function isRetryableError(err: unknown): boolean {
  if (err instanceof TerminalError) return false;
  if (err instanceof HTTPFetchError) {
    const status = err.status;
    return status === 0 || status === 429 || status >= 500;
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
