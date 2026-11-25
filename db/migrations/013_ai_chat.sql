-- AIチャット (/ai) のスレッドとメッセージ
CREATE TABLE IF NOT EXISTS ai_threads (
    id TEXT PRIMARY KEY,
    guild_id BIGINT NOT NULL,
    title TEXT NOT NULL DEFAULT '新しいチャット',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_messages (
    id BIGSERIAL PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES ai_threads (id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    -- ツール実行の記録 (name / 引数要約 / 結果要約) をUI表示用に保持
    tool_runs JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_thread ON ai_messages (thread_id, id);
CREATE INDEX IF NOT EXISTS idx_ai_threads_guild_updated ON ai_threads (guild_id, updated_at DESC);
