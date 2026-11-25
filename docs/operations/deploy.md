# デプロイ

[目次](../README.md)

本番はk3s (Argo CD) で運用しています。マニフェストは別リポジトリ [y-exe/vps](https://github.com/y-exe/vps) の `apps/` にあります。

## デプロイ順序

1. マイグレーション (`cd db && bun run migrate`) — アプリの更新前に必ず実行
2. イメージのビルドとpush (GitHub Actions)
3. vpsリポジトリのマニフェスト更新 → Argoが自動同期 → Podのロールアウトを確認

## イメージ

GitHub Actions (`ghcr-publish.yml`) が `main` へのpushを受け、`bun run check` の後に `ghcr.io` へイメージをpushします。タグは `sha-<コミット短縮hash>` です。

| ジョブ | イメージ |
| --- | --- |
| build-and-push-frontend | `ghcr.io/y-exe/discord-analytics-frontend` (統合コンテナ: Next.js SSR + `/api` Honoマウント) |
| build-and-push-bot | `ghcr.io/y-exe/discord-analytics-bot` (収集Bot) |
| build-and-push-agent | `ghcr.io/y-exe/discord-analytics-agent` (AIコマンド実行専用コンテナ。秘密なし) |

コンテキストはリポジトリルートです (共有ソースを含めるため)。agentイメージのみ `agent/` をコンテキストにします。

## AI機能の配備

frontend Podにagentサイドカーを追加し、AI機能 (`/ai`) を有効にします。詳細は [AIページ](../guide/ai.md) 参照。

- frontendのDeploymentにagentコンテナを追加し、両コンテナで `agent-sock` (emptyDir) を `/agent-sock` にマウントする
- frontend側: `AI_AGENT_SOCKET=/agent-sock/agent.sock`、Secretに `DEEPSEEK_API_KEY` を追加 (`AI_REQUIRE_ADMIN` は既定true)
- agent側: envFromなし (秘密を渡さない)、`fsGroup: 1000` でsocketファイルをnodeユーザーが作成できるようにする
- マイグレーション: `db/migrations/013_ai_chat.sql` (`cd db && bun run migrate`)

> [!NOTE]
> 2026-11-24にイメージ・内部名から固有要素 (ymkw) を除去しました: イメージ名は `discord-analytics-backend/bot/frontend`、ログプレフィックスは `discord-analytics-api:`、ディスクキャッシュは `discord_analytics_diskcache_v14`、管理者cookieは `__Secure-analytics_admin`、Botの月次ロール進捗キーは `discord-analytics-monthly-role:`。イメージ名変更に合わせて vpsリポジトリの k3sマニフェスト (Deployment/Service/Secret名・image参照) も同時にリネームしてください (`ymkw-frontend` → `discord-analytics-frontend` 等)。

## Secret

- SecretsはSOPS/age (`secrets/*.enc.yaml`、実体はvpsリポジトリ) で管理し、Argoの同期対象外のため手動applyします。
  ```bash
  # vpsリポジトリのルートから。復号内容を端末やファイルに出さない
  sudo SOPS_AGE_KEY_FILE=/root/.config/sops/age/keys.txt bash scripts/apply-secrets.sh
  ```
- 環境変数Secret (`ymkw-frontend-env`・`ymkw-bot-env`) を更新したらPodの再起動が必要です。
- Secretの値はログ・チャット・Issueに貼らないでください (SOPSの中身も同様)。`ymkw-backend-env` は統合コンテナ移行後に退役していますが、流出時の再発防止として内容の更新を継続します。

## ロールアウトとロールバック

```bash
sudo kubectl -n apps rollout status deployment/ymkw-frontend
sudo kubectl -n apps rollout status deployment/ymkw-bot
```

通常のロールバックはvpsリポジトリの `git revert` とpushです。DBスキーマのrevertは別途手順が必要です。

## URLと検証の既定

| URL | 想定 |
| --- | --- |
| `/` | 最新公開月の統計を直接描画 |
| `/month/{year}/{month}`・`/all`・`/month/latest` | クエリ形式 (`/?m=...`) へのリダイレクト |
| `/api/health` | APIの健康確認 (DB疎通込み、正常時は `ok` を返す) |
| `/healthz` | Next.jsネイティブルート (DB非依存、プローブ用) |

外部検証の最低ライン: 80→301、`/api/health`→200、`/relation`→200、`/?m=YYYY-MM`→200。
