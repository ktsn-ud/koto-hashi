import express from 'express';
import { middleware, SignatureValidationFailed } from '@line/bot-sdk';
import 'dotenv/config';

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

const app = express();

// テスト用 & 死活用エンドポイント
app.get('/', (_req, res) => {
  res.status(200).send('OK');
});

// LINE Webhookエンドポイント
app.post('/webhook', middleware(lineConfig), (req, res) => {
  // Handle webhook events here
  res.status(200).send('OK');
});

// 共通エラーハンドラ
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
