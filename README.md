# koto-hashi

LINE Bot の webhook を受け取り、翻訳返信を行う TypeScript サービスです。  
受信イベントはまず DB に保存し、HTTP 応答後に非同期で処理します。

## 主な機能

- LINE webhook の受信 (`POST /webhook`)
- 受信イベントの永続化と非同期処理（at-least-once 前提）
- Google GenAI (Gemini) による翻訳 + 再翻訳
- グループごとの翻訳先言語設定（メンション経由で登録）
- `message` / `unsend` / `join` イベントの処理
- Upstash Redis によるユーザー単位レート制限（`10/分` と `30/日`）
- 失敗時の再試行（指数バックオフ、最大 5 回）
- API/Webhook/イベントログの保存
- 30 日より古いログ・完了済みイベントの定期削除
- Cloudflare Workers による定期ヘルスチェック（5 分ごと）

## 技術スタック

- Node.js + TypeScript
- Express
- Prisma + CockroachDB
- LINE Messaging API (`@line/bot-sdk`)
- Google GenAI (`@google/genai`)
- Upstash Redis + `@upstash/ratelimit`
- Cloudflare Workers + Wrangler（`workers/`）

## ディレクトリ構成

```text
.
├── src/
│   ├── server.ts                    # Web サーバー / webhook 受信
│   ├── eventProcessor.ts            # イベント処理ループと再試行制御
│   ├── eventRepo.ts                 # イベント DB 操作
│   ├── logRepo.ts                   # API/Webhook ログ DB 操作
│   ├── cleanupRepo.ts               # 古いデータの削除
│   ├── translator.ts                # Gemini 翻訳呼び出し
│   ├── langDetector.ts              # 言語コード検出（Gemini）
│   ├── langRepo.ts                  # グループ言語設定の DB 操作
│   ├── message/
│   │   ├── join_message.txt
│   │   └── lang_registered_message.txt
│   └── prompt/
│       ├── translator.md
│       └── langDetector.md
├── prisma/
│   ├── schema.prisma
│   └── migrations/
└── workers/
    ├── src/index.ts                 # Cloudflare Worker (定期ヘルスチェック)
    └── wrangler.jsonc
```

## 事前準備

- Node.js（LTS 推奨）
- pnpm
- CockroachDB 接続情報
- LINE Messaging API のチャネル情報
- Google API キー
- Upstash Redis

## 環境変数（アプリ本体）

`.env` に以下を設定してください。

```dotenv
# Database
DATABASE_URL=
SHADOW_DATABASE_URL=

# LINE
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=

# Google GenAI
GOOGLE_API_KEY=

# Upstash Redis
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Optional
TARGET_LANG_CODE_DEFAULT=en-US
PORT=3000
```

- `TARGET_LANG_CODE_DEFAULT` はグループ言語未登録時の翻訳先デフォルトです（未指定時 `en-US`）。
- レート制限キーは `sourceUserId` で判定します（取得不可時は `unknown`）。

## ローカル起動手順

1. 依存関係をインストール

```bash
pnpm install
```

2. Prisma Client を生成

```bash
pnpm prisma:generate
```

3. マイグレーションを適用（開発環境）

```bash
pnpm prisma:migrate:dev
```

4. 開発サーバーを起動

```bash
pnpm dev
```

疎通確認:

```bash
curl http://localhost:3000/
```

## LINE webhook 設定

- Callback URL: `https://<your-domain>/webhook`
- Webhook 署名検証は `@line/bot-sdk` ミドルウェアで実施
- 無効署名は `401 Invalid signature` を返却

## 処理フロー

1. `POST /webhook` でイベント受信
2. 受信イベントを `LineWebhookEvent` に `RECEIVED` で保存
3. 即時 `200` 応答を返却
4. Processor がイベントを `PROCESSING` にして処理
5. 結果に応じて `DONE / IGNORED / FAILED_RETRYABLE / FAILED_TERMINAL` に更新

### テキスト翻訳フロー

- グループの場合、`GroupidLanguageMapping` から翻訳先言語を取得
- 未登録ならデフォルト言語で翻訳し、登録案内を返信
- 翻訳結果と再翻訳結果を返信

### 言語登録フロー（メンション時）

- Bot メンション付きメッセージを言語登録イベントとして処理
- `langDetector.ts` で言語コード（BCP 47）を検出
- `GroupidLanguageMapping` に upsert
- 登録結果メッセージ + あいさつ文（翻訳済み）を返信
- 例: 「おじさん構文」は `ja-JP-x-ojisan` として登録可能

### `unsend` イベント

- 対象 `messageId` の `messageText` を `null` にマスク
- 対象メッセージ未保存時は再試行対象

### `join` イベント

- グループ参加時に `src/message/join_message.txt` の内容を返信

### 再試行ポリシー

- 最大試行回数: 5
- バックオフ: `1s, 2s, 4s, ...`（上限 60s）
- `HTTP 4xx (408 を除く)` は終端失敗 (`FAILED_TERMINAL`)

### 定期実行

- イベント処理: 3 秒ごとにポーリング + webhook 受信時に即時トリガー
- クリーンアップ: 起動時 1 回 + 24 時間ごと
- 30 日より古い以下データを削除
  - `LineApiRequestLog`
  - `LineWebhookLog`
  - `LineWebhookEvent`（`DONE / IGNORED / FAILED_TERMINAL` のみ）

## Cloudflare Workers（任意）

`workers/` には死活監視 Worker が含まれます。

- Cron: `*/5 * * * *`
- `TARGET_ENDPOINT_URL` に `GET` を実行
- `HEALTHCHECK_RETRIES` / `HEALTHCHECK_TIMEOUT_MS` は環境ごとに設定可能

実行例:

```bash
pnpm workers run dev
pnpm workers run deploy
```

## 主要スクリプト（ルート）

```bash
pnpm dev
pnpm build
pnpm start
pnpm lint
pnpm lint:fix
pnpm format
pnpm prisma:generate
pnpm prisma:status
pnpm prisma:migrate:dev
pnpm prisma:migrate:deploy
pnpm prisma:migrate:reset
pnpm prisma:studio
```

## 補足

- 翻訳プロンプトは `src/prompt/translator.md`、言語検出プロンプトは `src/prompt/langDetector.md` を使用します。
- graceful shutdown を実装しており、終了時に in-flight 処理の完了を可能な範囲で待機します。
