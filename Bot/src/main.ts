import { ActivityType, Client, Events, GatewayIntentBits, Options, REST, Routes } from "discord.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { adjustDbDsn, BOT_ADMIN_ID_URL, TOKEN } from "./config";
import { initializeBotAdmins, refreshBotAdmins } from "./domain/permissions";
import { createPool } from "./db";
import { deactivateGuild, syncGuildRegistry } from "./guildRegistry";
import { loadLogger } from "./cogs/logger";
import { loadRanking, rankingCommandDefinitions } from "./cogs/ranking";
import { loadSetup, setupCommandDefinitions } from "./cogs/setup";
import { loadSync } from "./cogs/sync";
import { loadEmojiAssets, syncApplicationEmojis } from "./ui/emoji-sync";
import { uiEmoji } from "./ui/emojis";

type ClientT = import("discord.js").Client<true>;
type PoolT = import("pg").Pool;
export async function startBot(): Promise<{ shutdown(): Promise<void> }> {
  if (!TOKEN) {
    console.error("エラー: DISCORD_TOKEN が設定されていません。");
    process.exit(1);
  }
  const token = TOKEN;

  const dsn = await adjustDbDsn(process.env.DB_DSN);
  if (!dsn) {
    console.error("エラー: DB_DSN が設定されていません。");
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    makeCache: Options.cacheWithLimits({
      MessageManager: { maxSize: 100 },
    }),
    // ステータスメッセージ (tokumei-botと同じCustom Activity)
    presence: {
      activities: [
        {
          name: "/setup | DiscordAnalytics by yexe",
          state: "/setup | DiscordAnalytics by yexe",
          type: ActivityType.Custom,
        },
      ],
    },
  });

  const pool = createPool(dsn, { max: 5, applicationName: "discord-analytics-bot" });

  // Bot管理者IDを取得先から読み込む (失敗してもフォールバックIDで起動を続ける)
  await initializeBotAdmins(BOT_ADMIN_ID_URL, async (url) => {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "discord-analytics-bot" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  });
  const adminRefresh = setInterval(() => void refreshBotAdmins(), 60_000);
  adminRefresh.unref();

  client.once(Events.ClientReady, async (ready) => {
    console.log(`ログイン完了: ${ready.user.tag}`);
    try {
      const rest = new REST().setToken(token);
      const synced = (await rest.put(Routes.applicationCommands(ready.user.id), {
        body: [...rankingCommandDefinitions(), ...setupCommandDefinitions()],
      })) as unknown[];
      console.log(`コマンド同期: ${synced.length}`);
    } catch (error) {
      console.error(`同期エラー: ${error}`);
    }

    // ステータス・案内用のアプリ絵文字を同期 (失敗しても致命的ではない)
    try {
      const result = await syncApplicationEmojis(
        {
          list: async () => {
            const all = await ready.application.emojis.fetch();
            return all.map((e) => ({ name: e.name, animated: e.animated, id: e.id }));
          },
          create: async (name, image) => {
            const emoji = await ready.application.emojis.create({ attachment: image, name });
            return { name: emoji.name, animated: emoji.animated, id: emoji.id };
          },
        },
        await loadEmojiAssets(),
      );
      Object.assign(uiEmoji, result.mappings);
      console.log(
        `絵文字同期: 作成${result.created} / 再利用${result.reused}${result.failed.length ? ` / 失敗${result.failed.join(",")}` : ""}`,
      );
    } catch (error) {
      console.error(`絵文字同期エラー: ${error}`);
    }

    try {
      await syncGuildRegistry(pool, ready.guilds.cache.values());
    } catch (error) {
      console.error(`ギルド登録エラー: ${error}`);
    }
  });

  client.on(Events.GuildCreate, (guild) => {
    void syncGuildRegistry(pool, [guild]).catch((error) => {
      console.error(`ギルド登録エラー: ${error}`);
    });
  });
  client.on(Events.GuildDelete, (guild) => {
    void deactivateGuild(pool, guild.id).catch((error) => {
      console.error(`ギルド登録解除エラー: ${error}`);
    });
  });

  loadLogger(client, pool);
  const stopRanking = loadRanking(client, pool);
  loadSetup(client, pool);
  loadSync(client, pool);

  client.on("error", (error) => {
    console.error(`Discord接続エラー: ${error}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`未処理のPromiseエラー: ${reason}`);
  });

  try {
    await client.login(token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("token") || /an invalid token|401/i.test(message)) {
      console.error("トークン無効");
    } else {
      console.error(`エラー: ${error}`);
    }
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopRanking();
    console.log(`停止: ${signal} を受信`);
    try {
      await pool.end();
    } finally {
      client.destroy();
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return {
    shutdown: () => {
      void client.destroy();
      return pool.end();
    },
  };
}

// 直接実行時のみ起動 (local.tsからはstartBotを明示的に呼ぶ)
const isDirectRun =
  !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) void startBot();
