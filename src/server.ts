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
import { detectTargetLanguage } from './langDetector.ts';
import { getLanguageCodeByGroupId } from './langRepo.ts';
import { insertLineApiRequestLog, insertLineWebhookLog } from './logRepo.ts';
import {
  insertNewEventsBatch,
  maskMessageTextByMessageId,
} from './eventRepo.ts';
import type { NewEventRow } from './eventRepo.ts';
import { cleanupOldLogsAndEvents } from './cleanupRepo.ts';
import {
  runProcessorOnce,
  waitForProcessorIdle,
  TerminalError,
} from './eventProcessor.ts';
import { prisma } from './prisma.ts';
import 'dotenv/config';
import { upsertGroupidLanguageMapping } from './langRepo.ts';

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

/**
 * LINE Webhook受信エンドポイント。
 *
 * この関数がやること:
 * - 受け取ったイベントをDBに保存する
 * - LINEへHTTPレスポンスを返す
 *
 * この関数がやらないこと:
 * - 1件ごとの翻訳や返信
 * - イベントの状態更新（DONE/FAILEDなど）
 */
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  // Webhookリクエストのログを保存するハンドラを登録
  const receivedTime = new Date();
  let isWebhookLogged = false;
  const logWebhookRequest = () => {
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
  const events: webhook.Event[] = req.body?.events ?? [];
  const rows = events.map((event) => toEventRow(event));

  try {
    // 先に永続化を行う
    await insertNewEventsBatch(rows);

    // 保存ができ次第、即座にレスポンスを返す
    res.status(200).end();

    // イベント処理を非同期で開始
    setImmediate(triggerProcessor);
  } catch (err) {
    // 永続化に失敗した場合は500エラーを返し、再配信を期待する
    console.error(`[Error] Failed to persist webhook events: ${err}`);
    res.status(500).end();
  }
});

// --------------------------
// イベントハンドラ
// --------------------------

/**
 * 1件のテキストイベントに対して翻訳と返信を行う。
 *
 * この関数がやること:
 * - レート制限チェック
 * - 翻訳
 * - 返信
 *
 * この関数がやらないこと:
 * - DBの状態更新（DONE/FAILEDなど）
 *
 * @throws Error / TerminalError
 * 返信に失敗したら上位へ投げる（再試行するかの判断は上位で行う）。
 */
async function handleTextEvent(args: {
  replyToken: string;
  quoteToken: string;
  messageText: string;
  sourceUserId: string | null;
  sourceGroupId: string | null;
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
      throwAsTerminalIfNeeded(err);
    }
    return;
  }

  let replyText = '';

  // 翻訳言語の取得
  let targetLanguageCode: string;
  if (args.sourceGroupId) {
    targetLanguageCode =
      (await getLanguageCodeByGroupId(args.sourceGroupId)) ||
      process.env.TARGET_LANG_CODE_DEFAULT ||
      'en-US';
  } else {
    // グループIDが取得できない場合は、環境変数のデフォルト値を使用する
    targetLanguageCode = process.env.TARGET_LANG_CODE_DEFAULT || 'en-US';
  }

  // 翻訳処理
  try {
    const { translatedText, reTranslatedText, failure } = await translateText(
      args.messageText,
      targetLanguageCode
    );
    replyText += failure
      ? '[Error] Could not identify the language of the input message.'
      : `🌍 Translation\n${translatedText}\n\n──────────────────\n🔁 Back Translation\n${reTranslatedText}`;
    console.log(`[Info] Successfully translated message.`);
  } catch (err) {
    console.error(`[Error] Translation failed: ${err}`);
    replyText +=
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
    throwAsTerminalIfNeeded(err);
  }
}

/**
 * 1件の送信取消イベントに対してメッセージテキストのマスクを行う。
 *
 * この関数がやること:
 * - メッセージテキストのマスク
 *
 * この関数がやらないこと:
 * - DBの状態更新（DONE/FAILEDなど）
 *
 * @throws Error
 * マスクに失敗したら上位へ投げる（再試行するかの判断は上位で行う）。
 */
async function handleUnsendEvent(args: { messageId: string }): Promise<void> {
  console.log(`[Info] Received unsend event for messageId: ${args.messageId}`);
  try {
    const result = await maskMessageTextByMessageId(args.messageId);

    if (result === 'messageNotFound') {
      throw new Error(`Unsend target message not found yet: ${args.messageId}`);
    }

    if (result === 'masked') {
      console.log(
        `[Info] Successfully masked message text for messageId: ${args.messageId}`
      );
      return;
    }

    console.log(
      `[Info] Message was already masked (or had no text): ${args.messageId}`
    );
  } catch (err) {
    console.error(
      `[Error] Failed to mask message text for messageId: ${args.messageId}, error: ${err}`
    );
    throw err;
  }
}

/**
 * 1件の言語登録イベントに対して、言語コードの検出とDBへの保存を行う。
 *
 * この関数がやること:
 * - レート制限チェック
 * - 言語コードの検出
 * - DBへの保存
 * - 返信
 *
 * この関数がやらないこと:
 * - DBの状態更新（DONE/FAILEDなど）
 *
 * @throws Error / TerminalError
 * 返信に失敗したら上位へ投げる（再試行するかの判断は上位で行う）。
 */
async function handleLanguageRegistration(args: {
  sourceUserId: string | null;
  replyToken: string;
  quoteToken: string;
  groupId: string;
  messageText: string;
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
      throwAsTerminalIfNeeded(err);
    }
    return;
  }

  // メッセージから言語の検出
  let languageCode: string;
  let detectionFailed = false;
  let replyText: string;
  try {
    const detectionResult = await detectTargetLanguage(args.messageText);
    if (detectionResult.failure) {
      detectionFailed = true;
      switch (detectionResult.failureReason) {
        case 'NOT_A_LANGUAGE_SPECIFICATION':
          replyText =
            '[Error] The message does not appear to specify a language. Please include the name of the language you want to set.';
          break;
        case 'UNRECOGNIZABLE_LANGUAGE':
          replyText =
            '[Error] Could not recognize the specified language. Please check the language name and try again.';
          break;
      }
    } else {
      languageCode = detectionResult.languageCode;
      replyText = `✅️ The language for this group has been set to ${languageCode}.`;
      console.log(
        `[Info] Detected language code "${languageCode}" at group ${args.groupId} from message: ${args.messageText}`
      );
    }
  } catch (err) {
    console.log(`[Error] Language detection failed: ${err}`);
    detectionFailed = true;
    replyText =
      '[Error] An internal error occurred while detecting the language from the message.';
  }

  // 検出に失敗した場合は返信して終了
  if (detectionFailed) {
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
      console.log(`[Info] Successfully replied to language detection failure.`);
      return;
    } catch (err) {
      throwAsTerminalIfNeeded(err);
    }
  }

  // 検出に成功した場合はDBに保存
  try {
    await upsertGroupidLanguageMapping(args.groupId, languageCode!);
    console.log(
      `[Info] Successfully upserted language mapping for group ${args.groupId} with language code "${languageCode!}"`
    );
  } catch (err) {
    console.error(
      `[Error] Failed to upsert language mapping for group ${args.groupId}: ${err}`
    );
    throw err;
  }

  // 言語コード登録成功の返信
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
    console.log(
      `[Info] Successfully replied to language registration success.`
    );
  } catch (err) {
    throwAsTerminalIfNeeded(err);
  }
}

// --------------------------
// utils
// --------------------------

/**
 * webhook.Event を NewEventRow に変換する
 *
 * この関数がやること:
 * - Webhookイベントから、DB保存用の値を取り出す
 *
 * @param event LINE webhookイベント
 * @return データベース用のイベント行データ
 */
function toEventRow(event: webhook.Event): NewEventRow {
  function isMessageEvent(event: webhook.Event): event is webhook.MessageEvent {
    return event.type === 'message';
  }

  function isTextMessageEvent(
    event: webhook.Event
  ): event is webhook.MessageEvent & { message: webhook.TextMessageContent } {
    return event.type === 'message' && event.message.type === 'text';
  }

  function isUnsendEvent(event: webhook.Event): event is webhook.UnsendEvent {
    return event.type === 'unsend';
  }

  function isMentioned(event: webhook.Event): boolean {
    if (!isTextMessageEvent(event)) return false;
    if (!event.message.mention) return false;
    for (const mentionee of event.message.mention.mentionees) {
      if (mentionee.type === 'user' && mentionee.isSelf) return true;
    }
    return false;
  }

  const replyToken = 'replyToken' in event ? event.replyToken : null;

  let quoteToken: string | null = null;
  let messageText: string | null = null;
  let messageId: string | null = null;

  if (isMessageEvent(event)) {
    messageId = event.message.id;
  }

  if (isUnsendEvent(event)) {
    messageId = event.unsend.messageId;
  }

  if (isTextMessageEvent(event)) {
    quoteToken = event.message.quoteToken;
    messageText = event.message.text;
  }

  let sourceGroupId: string | null = null;
  if (event.source?.type === 'group') {
    sourceGroupId = event.source.groupId;
  }

  return {
    webhookEventId: event.webhookEventId,
    lineTimestampMs: BigInt(event.timestamp),
    eventType: event.type,
    sourceUserId: event.source?.userId || null,
    sourceGroupId,
    replyToken,
    quoteToken,
    messageText,
    messageId,
    isMentioned: isMentioned(event),
  };
}

/**
 * Processorの起動トリガー。
 *
 * この関数がやること:
 * - シャットダウン中か確認する
 * - runProcessorOnceを起動する
 *
 * この関数がやらないこと:
 * - イベント取得
 * - 翻訳や返信
 * - DBの状態更新
 */
function triggerProcessor() {
  if (isShuttingDown) return;
  void runProcessorOnce(
    handleTextEvent,
    handleUnsendEvent,
    handleLanguageRegistration
  ).catch((err) => {
    console.error(`[Error] Event processing failed: ${err}`);
  });
}

function triggerCleanup() {
  if (isShuttingDown || cleanupInFlight) return;
  cleanupInFlight = cleanupOldLogsAndEvents()
    .catch((err) => {
      console.error(`[Error] Cleanup failed: ${err}`);
    })
    .finally(() => {
      cleanupInFlight = null;
    });
}

/**
 * Messaging APIエラーを再試行可否で分類し、必要に応じてTerminalErrorへ変換する。
 *
 * この関数がやること:
 * - HTTPステータスを見て、再試行しないエラーをTerminalErrorに変換する
 *
 * この関数がやらないこと:
 * - DB更新
 */
function throwAsTerminalIfNeeded(err: unknown): never {
  if (err instanceof HTTPFetchError) {
    const status = err.status ?? 0;
    if (status >= 400 && status < 500 && status !== 408) {
      throw new TerminalError(
        `Non-retryable LINE reply error (status=${status})`
      );
    }
  }
  throw err;
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
  } catch (err) {
    const httpError = err instanceof HTTPFetchError ? err : undefined;
    void insertLineApiRequestLogSafe({
      occurredAt: replyTime,
      xLineRequestId: getXLineRequestId(httpError?.headers),
      httpMethod: 'POST',
      apiEndpoint: LINE_REPLY_ENDPOINT,
      lineStatusCode: httpError?.status ?? 0,
    });
    throw err;
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

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let cleanupInFlight: Promise<void> | null = null;
let isShuttingDown = false;

// 起動時に古いログとイベントのクリーンアップを実行
setImmediate(triggerCleanup);

// 定期的に古いログとイベントのクリーンアップを実行
const cleanupInterval = setInterval(triggerCleanup, CLEANUP_INTERVAL_MS); // 24時間ごとに実行

async function shutdown(signal: 'SIGTERM' | 'SIGINT') {
  if (isShuttingDown) {
    // すでにシャットダウン処理中の場合は何もしない
    return;
  }
  isShuttingDown = true;

  // イベント処理の停止
  clearInterval(eventProcessingInterval);

  // クリーンアップ処理の停止
  clearInterval(cleanupInterval);

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
