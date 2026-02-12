import express from 'express';
import {
  messagingApi,
  middleware,
  webhook,
  HTTPFetchError,
  SignatureValidationFailed,
} from '@line/bot-sdk';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { translateText } from './translator.ts';
import { insertLineApiRequestLog, insertLineWebhookLog } from './logRepo.ts';
import { upsertNewEvent } from './eventRepo.ts';
import type { NewEventRow } from './eventRepo.ts';
import { runProcessorOnce, waitForProcessorIdle } from './eventProcessor.ts';
import { prisma } from './prisma.ts';
import 'dotenv/config';

// --------------------------
// LINE Botの設定
// --------------------------
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

if (!lineConfig.channelAccessToken || !lineConfig.channelSecret) {
  throw new Error(
    'LINE channel access token or secret is not set in environment variables.'
  );
}

const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

interface TextMessageV2 {
  type: 'textV2';
  text: string;
  substitution?: { [key: string]: any };
  quoteToken?: string;
}

const LINE_REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply';

// --------------------------
// レートリミットの設定
// --------------------------
const redis = Redis.fromEnv();

const ratelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '1 m'), // 1分間に30回
  analytics: true,
});

// --------------------------
// Expressサーバー
// --------------------------
const app = express();
const pendingWebhookLogWrites = new Set<Promise<void>>();

// --------------------------
// エンドポイント
// --------------------------

// テスト用 & 死活用エンドポイント
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

// LINE Webhookエンドポイント
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  // Webhookリクエストのログを保存するハンドラを登録
  let isWebhookLogged = false;
  const logWebhookRequest = () => {
    const receivedTime = new Date();
    if (isWebhookLogged) {
      return;
    }
    isWebhookLogged = true;
    const isResponseCommitted = res.writableEnded || res.headersSent;
    const writePromise = insertLineWebhookLog({
      occurredAt: receivedTime,
      senderIp: req.ip || req.socket.remoteAddress || 'unknown',
      requestPath: req.path,
      serverStatusCode: isResponseCommitted ? res.statusCode : 0, // レスポンスが未送信の場合は0
      webhookHttpMethod: req.method,
    })
      .catch((err) => {
        console.error(`[Error] Failed to log webhook request: ${err}`);
      })
      .finally(() => {
        pendingWebhookLogWrites.delete(writePromise);
      });
    pendingWebhookLogWrites.add(writePromise);
  };

  res.once('finish', logWebhookRequest);
  res.once('close', logWebhookRequest);

  // イベントを保存しておき、処理をレスポンス後に行う
  const events: webhook.Event[] = req.body.events ?? [];

  try {
    await Promise.all(events.map((event) => upsertNewEvent(toEventRow(event))));

    res.status(200).end();

    // イベント処理を非同期で開始
    setImmediate(triggerProcessor);

    return;
  } catch (err) {
    console.error(`[Error] Failed to persist webhook events: ${err}`);
    res.status(500).end();
  }
});

// --------------------------
// イベントハンドラ
// --------------------------
async function handleTextEvent(args: {
  replyToken: string;
  quoteToken: string;
  messageText: string;
  sourceUserId: string | null;
}): Promise<void> {
  // rate limit のチェック
  const userId = args.sourceUserId || 'unknown';
  const { success } = await ratelimit.limit(userId);
  if (!success) {
    const reply: TextMessageV2 = {
      type: 'textV2',
      text: '[Error] You are sending messages too frequently. Please slow down a bit.',
      quoteToken: args.quoteToken,
    };
    console.warn(`[Warn] Rate limit exceeded for user: ${userId}`);
    try {
      await replyMessageWithLogging({
        replyToken: args.replyToken,
        messages: [reply],
      });
      console.log(`[Info] Successfully replied to rate limit exceedance.`);
    } catch (err) {
      console.error(`[Error] Reply failed: ${err}`);
    }
    return;
  }

  // 翻訳処理
  let replyText: string;

  try {
    const { translatedText, reTranslatedText, failure } = await translateText(
      args.messageText
    );
    replyText = failure
      ? '[Error] Could not identify the language of the input message.'
      : `${translatedText}\n\n---- reTranslated ----\n${reTranslatedText}`;
    console.log(`[Info] Successfully translated message.`);
  } catch (err) {
    console.error(`[Error] Translation failed: ${err}`);
    replyText =
      '[Error] An internal error occurred while translating the message.';
  }

  // 返信処理
  const reply: TextMessageV2 = {
    type: 'textV2',
    text: replyText,
    quoteToken: args.quoteToken,
  };

  try {
    await replyMessageWithLogging({
      replyToken: args.replyToken,
      messages: [reply],
    });
    console.log(`[Info] Successfully replied to message.`);
  } catch (err) {
    console.error(`[Error] Reply failed: ${err}`);
  }
}

// --------------------------
// utils
// --------------------------

function toEventRow(event: webhook.Event): NewEventRow {
  function isMessageEvent(event: webhook.Event): event is webhook.MessageEvent {
    return event.type === 'message';
  }

  function isTextMessageEvent(
    event: webhook.Event
  ): event is webhook.MessageEvent & { message: webhook.TextMessageContent } {
    return event.type === 'message' && event.message.type === 'text';
  }

  const replyToken = 'replyToken' in event ? event.replyToken : null;

  let quoteToken: string | null = null;
  let messageText: string | null = null;
  let messageId: string | null = null;

  if (isMessageEvent(event)) {
    messageId = event.message.id;
  }

  if (isTextMessageEvent(event)) {
    quoteToken = event.message.quoteToken;
    messageText = event.message.text;
  }

  return {
    webhookEventId: event.webhookEventId,
    lineTimestampMs: BigInt(event.timestamp),
    eventType: event.type,
    sourceUserId: event.source?.userId || null,
    replyToken,
    quoteToken,
    messageText,
    messageId,
  };
}

/**
 * イベント処理を1回実行する（エラーハンドラ付き）
 */
function triggerProcessor() {
  void runProcessorOnce(handleTextEvent).catch((err) => {
    console.error(`[Error] Event processing failed: ${err}`);
  });
}

/**
 * Messaging API への返信を行い、APIリクエストログを保存する（失敗時もログ保存を試みる）
 */
async function replyMessageWithLogging(
  request: messagingApi.ReplyMessageRequest
) {
  const replyTime = new Date();
  try {
    const response = await lineClient.replyMessageWithHttpInfo(request);
    void insertLineApiRequestLogSafe({
      occurredAt: replyTime,
      xLineRequestId: getXLineRequestId(response.httpResponse.headers),
      httpMethod: 'POST',
      apiEndpoint: LINE_REPLY_ENDPOINT,
      lineStatusCode: response.httpResponse.status,
    });
    return response.body;
  } catch (error) {
    const httpError = error instanceof HTTPFetchError ? error : undefined;
    void insertLineApiRequestLogSafe({
      occurredAt: replyTime,
      xLineRequestId: getXLineRequestId(httpError?.headers),
      httpMethod: 'POST',
      apiEndpoint: LINE_REPLY_ENDPOINT,
      lineStatusCode: httpError?.status ?? 0,
    });
    throw error;
  }
}

/**
 * Messaging APIリクエストログの保存を行う。失敗時はコンソールにエラーを出力する。
 */
async function insertLineApiRequestLogSafe(row: {
  occurredAt: Date;
  xLineRequestId: string;
  httpMethod: string;
  apiEndpoint: string;
  lineStatusCode: number;
}) {
  try {
    await insertLineApiRequestLog(row);
  } catch (err) {
    console.error(`[Error] Failed to log Messaging API request: ${err}`);
  }
}

/**
 * ヘッダーから x-line-request-id を取得する。存在しない場合は 'unknown' を返す。
 */
function getXLineRequestId(headers?: Headers): string {
  if (!headers) {
    return 'unknown';
  }
  return headers.get('x-line-request-id') ?? 'unknown';
}

// --------------------------
// 共通エラーハンドラ
// --------------------------
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    if (err instanceof SignatureValidationFailed) {
      res.status(401).send('Invalid signature');
      return;
    }
    res.status(500).send('Internal Server Error');
  }
);

// --------------------------
// サーバーの起動・終了処理
// --------------------------

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`[Info] Server is running on port ${PORT}`);
});

// 定期的にイベント処理を実行
const eventProcessingInterval = setInterval(triggerProcessor, 3_000);

let isShuttingDown = false;

async function shutdown(signal: 'SIGTERM' | 'SIGINT') {
  if (isShuttingDown) {
    // すでにシャットダウン処理中の場合は何もしない
    return;
  }
  isShuttingDown = true;

  // イベント処理の停止
  clearInterval(eventProcessingInterval);

  console.log(`[Info] Received ${signal}. Shutting down gracefully...`);

  // 終了処理のタイムアウト設定
  const forceExitTimer = setTimeout(() => {
    console.error('[Error] Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  // HTTPサーバーを閉じる
  await new Promise<void>((resolve) => {
    server.close((err) => {
      if (err) {
        console.error(`[Error] Failed to close HTTP server: ${err}`);
      }
      resolve();
    });
  });

  // in-flight の webhook ログ書き込みを可能な限り待つ
  if (pendingWebhookLogWrites.size > 0) {
    await new Promise<void>((resolve) => {
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(finish, 5_000);
      timer.unref();

      void Promise.allSettled(Array.from(pendingWebhookLogWrites)).finally(
        finish
      );
    });
  }

  // in-flight のイベント処理を可能な限り待つ
  const processorBecameIdle = await waitForProcessorIdle(5_000);
  if (!processorBecameIdle) {
    console.warn('[Warn] Processor did not become idle before timeout.');
  }

  // Prismaクライアントの切断
  try {
    await prisma.$disconnect();
  } catch (err) {
    console.error(`[Error] Prisma disconnect failed: ${err}`);
  }

  clearTimeout(forceExitTimer);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
