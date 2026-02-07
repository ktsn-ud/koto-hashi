import express from 'express';
import {
  messagingApi,
  middleware,
  webhook,
  SignatureValidationFailed,
} from '@line/bot-sdk';
import { translateText } from './translator.ts';
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
// TODO: ロギングの強化
app.post('/webhook', middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(eventHandler))
    .then((result) => {
      console.log(result);
      res.status(200).end();
    })
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// --------------------------
// イベントハンドラ
// --------------------------
async function eventHandler(event: webhook.Event) {
  // メッセージイベント以外は無視
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  // このとき replyToken は存在が保証されるはず
  if (!event.replyToken) {
    return Promise.reject(new Error('replyToken is missing in the event'));
  }

  // 翻訳処理・返信
  const { translatedText, reTranslatedText } = await translateText(
    event.message.text
  );
  const replyText = `${translatedText}\n\n---- reTranslated ----\n${reTranslatedText}`;
  const reply: TextMessageV2 = { type: 'textV2', text: replyText };
  return lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [reply],
  });
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
