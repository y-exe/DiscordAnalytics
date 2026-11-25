import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { BOT_ADMIN_ID_URL, BOT_ADMIN_IDS, OWNER_ID } from "../config";

type IdLoader = (url: string) => Promise<string>;

/**
 * Bot管理者ディレクトリ (tokumei-botのdomain/permissions.tsと同じ方針)。
 * BOT_ADMIN_ID_URL から1件のユーザーIDを取得し、120秒キャッシュする。
 */
export class BotAdminDirectory {
  private ids = new Set<string>();
  private validUntil = 0;
  private pending?: Promise<void>;

  constructor(
    private readonly url: string | undefined,
    private readonly load: IdLoader,
    private readonly now: () => number = Date.now,
  ) {
    if (url) {
      const source = new URL(url);
      if (
        source.protocol !== "https:" ||
        source.username ||
        source.password ||
        (source.port && source.port !== "443")
      ) {
        throw new Error("BOT_ADMIN_ID_URLには認証情報を含まないHTTPSのURLを設定してください。");
      }
    }
  }

  has(userId: string): boolean {
    if (this.now() >= this.validUntil) return false;
    return this.ids.has(userId);
  }

  refresh(): Promise<void> {
    if (!this.url) return Promise.resolve();
    return (this.pending ??= Promise.resolve()
      .then(() => this.load(this.url!))
      .then((value) => {
        const id = value.trim();
        if (!/^[1-9]\d{16,19}$/.test(id)) {
          throw new Error("Bot管理者IDの取得先はDiscordユーザーIDを1件だけ返す必要があります。");
        }
        this.ids = new Set([id]);
        this.validUntil = this.now() + 120_000;
      })
      .finally(() => {
        this.pending = undefined;
      }));
  }
}

let directory: BotAdminDirectory | undefined;
/** URL取得に失敗した場合やローカル開発用のフォールバック (環境変数 + OWNER_ID) */
const fallbackIds = new Set<string>();

export async function initializeBotAdmins(url: string | undefined, load: IdLoader): Promise<void> {
  fallbackIds.clear();
  for (const id of BOT_ADMIN_IDS) fallbackIds.add(id);
  if (OWNER_ID && /^\d+$/.test(OWNER_ID)) fallbackIds.add(OWNER_ID);
  directory = new BotAdminDirectory(url?.trim() || undefined, load);
  await directory.refresh().catch((error) => {
    console.error(`Bot管理者IDの取得に失敗しました (フォールバックIDのみ使用): ${error}`);
  });
}

export async function refreshBotAdmins(): Promise<void> {
  await directory?.refresh().catch(() => {});
}

export function isBotAdmin(userId: string): boolean {
  if (fallbackIds.has(userId)) return true;
  return directory?.has(userId) ?? false;
}

type ManagerInteraction = {
  user: { id: string };
  inGuild: () => boolean;
  guild: { ownerId: string } | null;
  memberPermissions: Readonly<PermissionsBitField> | null;
};

/**
 * サーバー設定を変更できる管理者かどうか。
 * Bot管理者 / サーバー所有者 / サーバー管理 (ManageGuild, Administratorを含む) のいずれか。
 */
export function isGuildManager(interaction: ManagerInteraction): boolean {
  if (isBotAdmin(interaction.user.id)) return true;
  if (!interaction.inGuild()) return false;
  if (
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    return true;
  }
  return interaction.guild?.ownerId === interaction.user.id;
}
