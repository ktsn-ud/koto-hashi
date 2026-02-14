# koto-hashi

LINE Bot の webhook を受け取り、メッセージ翻訳と返信を行う TypeScript サービスです。  
受信イベントはまず DB に保存し、HTTP 応答を返したあとで非同期に処理します。

## 主な機能

- LINE webhook の受信 (`POST /webhook`)
- イベント永続化後に非同期処理（翻訳/返信）
- Google GenAI (Gemini) を使った翻訳 + 再翻訳
- Upstash Redis を使ったユーザー単位レート制限（30回/分）
- `unsend` イベント受信時のメッセージ本文マスク
- 失敗時の再試行（指数バックオフ、最大 5 回）
- API/Webhook/イベント処理ログの保存
- 30 日より古いログ・完了済みイベントの定期削除
- Cloudflare Workers による定期ヘルスチェック（5分ごと）

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
│   ├── server.ts           # Web サーバー / webhook 受信
│   ├── eventProcessor.ts   # イベント処理ループと再試行制御
│   ├── eventRepo.ts        # イベント DB 操作
│   ├── logRepo.ts          # ログ DB 操作
│   ├── translator.ts       # Gemini 翻訳呼び出し
│   ├── cleanupRepo.ts      # 古いデータの削除
│   └── prompt/system.md    # 翻訳用システムプロンプト
├── prisma/
│   ├── schema.prisma
│   └── migrations/
└── workers/
    ├── src/index.ts        # Cloudflare Worker (定期ヘルスチェック)
    └── wrangler.jsonc
```

## 事前準備

- Node.js（LTS 推奨）
- pnpm
- CockroachDB 接続情報
- LINE Messaging API のチャネル情報
- Google API キー
- Upstash Redis

## 環境変数

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

`TARGET_LANG_CODE_DEFAULT` は翻訳先言語コードのデフォルト値です（未指定時は `en-US`）。

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

起動後の疎通確認:

```bash
curl http://localhost:3000/
```

## LINE webhook 設定

- Callback URL: `https://<your-domain>/webhook`
- Webhook の署名検証は `@line/bot-sdk` ミドルウェアで実施
- 無効署名は `401 Invalid signature` を返します

## 処理フロー（概要）

1. `POST /webhook` でイベント受信
2. 受信イベントを `LineWebhookEvent` に `RECEIVED` で保存
3. 即時 `200` 応答を返却
4. 別処理でイベントを `PROCESSING` にして実行
5. 結果に応じて `DONE / IGNORED / FAILED_RETRYABLE / FAILED_TERMINAL` を更新

### 再試行ポリシー

- 最大試行回数: 5
- バックオフ: `1s, 2s, 4s, ...`（上限 60s）
- `HTTP 4xx (408 を除く)` は終端失敗 (`FAILED_TERMINAL`)

### `unsend` イベント

- 対象 `messageId` の `messageText` を `null` にマスク
- まだ対象メッセージが未保存の場合は再試行対象

### 定期クリーンアップ

- 起動時に 1 回実行
- 以降 24 時間ごとに実行
- 30 日より古い以下データを削除
  - `LineApiRequestLog`
  - `LineWebhookLog`
  - `LineWebhookEvent`（`DONE / IGNORED / FAILED_TERMINAL` のみ）

## Cloudflare Workers（任意）

`workers/` には、サーバーの死活監視用 Worker が含まれています。

- Cron: `*/5 * * * *`（5分ごと）
- `TARGET_ENDPOINT_URL` に対して `GET` を実行
- リトライ回数とタイムアウトは環境ごとに設定可能

### 実行例

```bash
# workers ワークスペースで開発実行
pnpm workers run dev

# workers ワークスペースを deploy
pnpm workers run deploy
```

## 主要スクリプト（ルート）

```bash
pnpm dev                   # 開発起動 (tsx watch)
pnpm build                 # ビルド (tsup)
pnpm start                 # 本番起動 (dist/server.cjs)
pnpm lint                  # ESLint
pnpm lint:fix              # ESLint --fix
pnpm format                # Prettier
pnpm prisma:generate
pnpm prisma:migrate:dev
pnpm prisma:migrate:deploy
pnpm prisma:studio
```

## 補足

- 翻訳プロンプトは `src/prompt/system.md` から読み込みます。
- 本サービスは graceful shutdown を実装しており、終了時に in-flight 処理の完了を待機します。
