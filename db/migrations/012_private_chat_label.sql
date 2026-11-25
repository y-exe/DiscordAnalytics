-- 集約チャンネルの表示名 (privateChatLabel) を導入する。
-- 未設定ギルドはバックエンドの既定値「その他」を使うため、マイグレーション自体は構造変更なし。
-- 既定ギルドは従来のハードコード表示「プラチャ」を維持する。
UPDATE guilds
SET display_config = jsonb_set(
        COALESCE(display_config, '{}'::jsonb),
        '{privateChatLabel}',
        to_jsonb('プラチャ'::text),
        TRUE
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE guild_id = 1355073968532619376;
