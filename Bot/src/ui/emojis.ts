export const fallbackEmoji = {
  check: "✅",
  flag: "🚩",
  warning: "⚠️",
  info: "ℹ️",
  error: "❌",
  time: "🕒",
  content: "📝",
  count: "🔢",
  reporter: "👤",
} as const;
export type EmojiKey = keyof typeof fallbackEmoji;
export const uiEmoji: Record<EmojiKey, string> = { ...fallbackEmoji };
// 名前は本Botアプリ固有 (tokumei-botと同素材だがアプリごとに別登録)
export const emojiDefinitions: Record<EmojiKey, { name: string }> = {
  check: { name: "da_check" },
  flag: { name: "da_flag" },
  warning: { name: "da_warning" },
  info: { name: "da_info" },
  error: { name: "da_error" },
  time: { name: "da_time" },
  content: { name: "da_content" },
  count: { name: "da_count" },
  reporter: { name: "da_reporter" },
};
