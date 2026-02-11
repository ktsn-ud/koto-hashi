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
app.post('/webhook', middleware(lineConfig), (req, res) => {
  const receiveTime = new Date();
  const senderIp = req.ip || 'unknown';
  const requestPath = req.path;
  const webhookHttpMethod = req.method;
  let isWebhookLogged = false;
  const logWebhookRequest = () => {
    if (isWebhookLogged) {
      return;
    }
    isWebhookLogged = true;
    const writePromise = insertLineWebhookLog({
      occurredAt: receiveTime,
      senderIp,
      requestPath,
      serverStatusCode: res.statusCode,
      webhookHttpMethod,
    })
      .catch((err) => {
        console.error(`[Error] Failed to log webhook request: ${err}`);
      })
      .finally(() => {
        pendingWebhookLogWrites.delete(writePromise);
      });
    pendingWebhookLogWrites.add(writePromise);
  };

  // finish が発火しない接続クローズでもログを取りこぼさない
  res.once('finish', logWebhookRequest);
  res.once('close', logWebhookRequest);

  Promise.all(req.body.events.map(eventHandler))
    .then(() => {
      res.status(200).end();
    })
    .catch((err) => {
      console.error(`[Error] ${err}`);
      res.status(500).end();
    });
});

// --------------------------
// イベントハンドラ
// --------------------------
async function eventHandler(event: webhook.Event) {
  // メッセージイベント以外は無視
  if (event.type !== 'message' || event.message.type !== 'text') {
    console.log(`[Info] Ignored event type: ${event.type}`);
    return Promise.resolve(null);
  }

  // このとき replyToken は存在が保証されるはず
  if (!event.replyToken) {
    return Promise.reject(new Error('ReplyToken is missing in the event'));
  }
  const quoteToken = event.message.quoteToken;

  // レートリミットチェック: 超過の場合はその旨のメッセージを送信
  const userId = event.source?.userId || 'unknown';
  const { success } = await ratelimit.limit(userId);
  if (!success) {
    const reply: TextMessageV2 = {
      type: 'textV2',
      text: '[Error] You are sending messages too frequently. Please slow down a bit.',
      quoteToken,
    };
    console.warn(`[Warn] Rate limit exceeded for user: ${userId}`);
    return replyMessageWithLogging({
      replyToken: event.replyToken,
      messages: [reply],
    });
  }

  // 翻訳処理・返信
  try {
    const originalText = event.message.text;
    const { translatedText, reTranslatedText, failure } =
      await translateText(originalText);
    const replyText = failure
      ? '[Error] Could not identify the language of the input message.'
      : `${translatedText}\n\n---- reTranslated ----\n${reTranslatedText}`;
    const reply: TextMessageV2 = {
      type: 'textV2',
      text: replyText,
      quoteToken,
    };
    console.log(`[Info] Successfully translated message.`);
    return replyMessageWithLogging({
      replyToken: event.replyToken,
      messages: [reply],
    });
  } catch (error) {
    // 翻訳（や返信）に失敗した場合のエラーハンドリング
    const reply: TextMessageV2 = {
      type: 'textV2',
      text: '[Error] An internal error occurred while translating or replying.',
      quoteToken,
    };
    console.error(`[Error] Translation or reply failed: ${error}`);
    return replyMessageWithLogging({
      replyToken: event.replyToken,
      messages: [reply],
    });
  }
}

// --------------------------
// utils
// --------------------------

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

let isShuttingDown = false;

async function shutdown(signal: 'SIGTERM' | 'SIGINT') {
  if (isShuttingDown) {
    // すでにシャットダウン処理中の場合は何もしない
    return;
  }
  isShuttingDown = true;

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
