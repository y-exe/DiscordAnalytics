# AIページ (/ai)

[目次](../README.md)

ダッシュボードに組み込みのAIチャット。サーバーのデータについて自然言語で質問すると、AIエージェントがDBやツールを使って調べて回答する。

## 使い方

- サイドバーの「AI」(`/ai`) から開く。
- 既定は**一般開放**。レート制限・1日上限でabuse対策をしている (`AI_REQUIRE_ADMIN=true` で管理者ログインのみに制限でき、その場合未ログインでは管理者パスワードの入力を求められる)。
- 入力カードに質問を入力して送信。過去のやり取りはスレッドとして保存され、「最近のチャット」やヘッダーから再開・削除できる。
- 回答はストリーミング表示。AIがDBやコマンドを実行した場合は実行内容がツールチップとして表示される。

## AIが使えるツール

| ツール | 内容 |
| --- | --- |
| `db_query` | 分析DB (PostgreSQL) への読み取り専用SQL。`SELECT`/`WITH`/`EXPLAIN` のみ、複数ステートメント禁止、8秒でタイムアウト、最大200行。スキーマはシステムプロンプトに自動注入される |
| `run_command` | agentコンテナ内での `sh -c` 実行。curl/git/jq/node等が使えるサンドボックス (秘密のenvなし、DBはマウントされない) |
| `web_search` | DuckDuckGo検索 (APIキー不要) |

## アーキテクチャ

- LLMはDeepSeek (`deepseek-chat`) 1本。OpenAI互換のstreaming chat completionで、ツール呼び出し (`tool_calls`) を最大12ラウンドまでループする。
- ルートは `backend/src/routes/ai.ts`。`POST /api/ai/chat` がSSE (`start` / `delta` / `tool` / `done` / `error`) を返す。
- 会話は `ai_threads` / `ai_messages` テーブルに保存 (`db/migrations/013_ai_chat.sql`)。
- コマンド実行はバックエンドからUnix socket (`AI_AGENT_SOCKET`) 経由でagentコンテナに委譲する (`agent/server.js`)。socketが無い環境 (開発PC) ではローカル実行にフォールバックする。
- 実装の参考: glm-ai-chat のエージェント構成。

## 環境変数

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | (なし) | 未設定ならAI機能は無効 (503) |
| `AI_ENABLED` | `true` | `false` でAI機能を無効化 |
| `AI_MODEL` | `deepseek-chat` | モデルID |
| `AI_BASE_URL` | `https://api.deepseek.com` | OpenAI互換APIのベースURL |
| `AI_AGENT_SOCKET` | (なし) | agentコンテナのUnix socketパス (k3sでは `/agent-sock/agent.sock`) |
| `AI_REQUIRE_ADMIN` | `false` | `true` で管理者セッションのみ利用可能に |
| `AI_RATE_LIMIT_PER_10MIN` | `20` | IPごとの10分あたりメッセージ上限 (管理者/Botは5倍) |
| `AI_DAILY_LIMIT_PER_IP` | `100` | IPごとの1日あたりメッセージ上限 (管理者/Botは適用外) |
| `AI_DAILY_LIMIT_GLOBAL` | `1000` | サイト全体の1日あたりメッセージ上限 (コストのサーキットブレーカー) |

abuse対策: `POST /api/ai/chat` は ①IPごとに10分あたり20メッセージ ②IPごとに1日100メッセージ ③サイト全体で1日1000メッセージ の3段階で制限する (管理者セッション/Botキーは日次上限の適用外)。無効化時 (`AI_ENABLED=false` / `DEEPSEEK_API_KEY` 未設定) はページに「無効」表示が出る。
