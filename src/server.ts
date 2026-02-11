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

// --------------------------
// エンドポイント
// --------------------------

// テスト用 & 死活用エンドポイント
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

// LINE Webhookエンドポイント
app.post('/webhook', middleware(lineConfig), (req, res) => {
  const receiveTime = new Date().toISOString();
  // webhook リクエストログを DB に保存 (レスポンス後にステータスコード確定)
  res.on('finish', () => {
    void (async () => {
      try {
        await insertLineWebhookLog({
          occurredAt: receiveTime,
          senderIp: req.ip || 'unknown',
          requestPath: req.path,
          serverStatusCode: res.statusCode,
          webhookHttpMethod: req.method,
          requestBody: req.body,
        });
      } catch (err) {
        console.error(`[Error] Failed to log webhook request: ${err}`);
      }
    })();
  });

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
    return replyMessageWithLogging(
      {
        replyToken: event.replyToken,
        messages: [reply],
      },
      event
    );
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
    return replyMessageWithLogging(
      {
        replyToken: event.replyToken,
        messages: [reply],
      },
      event
    );
  } catch (error) {
    // 翻訳（や返信）に失敗した場合のエラーハンドリング
    const reply: TextMessageV2 = {
      type: 'textV2',
      text: '[Error] An internal error occurred while translating or replying.',
      quoteToken,
    };
    console.error(`[Error] Translation or reply failed: ${error}`);
    return replyMessageWithLogging(
      {
        replyToken: event.replyToken,
        messages: [reply],
      },
      event
    );
  }
}

// --------------------------
// utils
// --------------------------

/**
 * Messaging API への返信を行い、APIリクエストログを保存する（失敗時もログ保存を試みる）
 */
async function replyMessageWithLogging(
  request: messagingApi.ReplyMessageRequest,
  webhookEvent: webhook.Event
) {
  const replyTime = new Date().toISOString();
  try {
    const response = await lineClient.replyMessageWithHttpInfo(request);
    void insertLineApiRequestLogSafe({
      occurredAt: replyTime,
      xLineRequestId: getXLineRequestId(response.httpResponse.headers),
      httpMethod: 'POST',
      apiEndpoint: LINE_REPLY_ENDPOINT,
      lineStatusCode: response.httpResponse.status,
      requestBody: request,
      responseBody: response.body ?? null,
      webhookEvent,
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
      requestBody: request,
      responseBody: parseJsonSafe(httpError?.body) ?? {
        error: String(error),
      },
      webhookEvent,
    });
    throw error;
  }
}

/**
 * Messaging APIリクエストログの保存を行う。失敗時はコンソールにエラーを出力する。
 */
async function insertLineApiRequestLogSafe(row: {
  occurredAt: string;
  xLineRequestId: string;
  httpMethod: string;
  apiEndpoint: string;
  lineStatusCode: number;
  requestBody: unknown;
  responseBody: unknown;
  webhookEvent: unknown;
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

/**
 * 安全にJSONをパースする。パースに失敗した場合は元の文字列を返す。
 */
function parseJsonSafe(raw?: string) {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
