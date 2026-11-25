import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { emojiDefinitions, fallbackEmoji, type EmojiKey } from "./emojis.js";

/** discord.jsのApplicationEmojiManagerが満たすべき最小インターフェース */
export interface EmojiApi {
  list(): Promise<Array<{ name: string; animated?: boolean; id: string }>>;
  create(name: string, image: Buffer): Promise<{ name: string; animated?: boolean; id: string }>;
}

export interface EmojiAsset {
  key: EmojiKey;
  image: Buffer;
}

export async function loadEmojiAssets(): Promise<EmojiAsset[]> {
  return Promise.all(
    (Object.keys(emojiDefinitions) as EmojiKey[]).map(async (key) => ({
      key,
      image: await readFile(new URL(`../../assets/emojis/${key}.png`, import.meta.url)),
    })),
  );
}

/** アプリ絵文字を同期する。既存 (同名) は再利用し、無ければ作成する。 */
export async function syncApplicationEmojis(api: EmojiApi, assets?: EmojiAsset[]) {
  const source = assets ?? (await loadEmojiAssets());
  const existing = await api.list();
  const mappings: Record<EmojiKey, string> = { ...fallbackEmoji };
  let created = 0,
    reused = 0;
  const failed: EmojiKey[] = [];
  for (const { key, image } of source) {
    const name = emojiDefinitions[key].name;
    let found = existing
      .filter((emoji) => emoji.name === name)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (found) reused++;
    else {
      try {
        found = await api.create(name, image);
        existing.push(found);
        created++;
      } catch {
        failed.push(key);
        continue;
      }
    }
    mappings[key] = `<${found.animated ? "a" : ""}:${found.name}:${found.id}>`;
  }
  return { mappings, created, reused, failed };
}
