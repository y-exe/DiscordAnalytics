import type { Guild } from "discord.js";
import type { Pool } from "pg";

export interface GuildConfigRow {
  guildId: string;
  name: string;
  announceChannelId: string | null;
  kingRoleId: string | null;
  excludedChannelIds: string[];
  domains: string[];
  /** ダッシュボードの代表ドメイン (is_primary = TRUE) */
  primaryDomains: string[];
}

export interface GuildConfigWithDisplay extends GuildConfigRow {
  displayConfig: Record<string, unknown> | null;
}

/** Web表示まわりの設定 (display_config JSONBの読みやすい形) */
export interface DisplaySettings {
  /** 集約チャンネルの表示名。「プラチャ」等。空なら「その他」 */
  privateChatLabel: string;
  /** このカテゴリ配下のチャンネルを集約する (空なら集約しない) */
  privateChatCategoryIds: string[];
  /** Webサイトに表示するチャンネルのホワイトリスト (空なら全表示) */
  whitelistChannelIds: string[];
  /** Webサイトから隠すチャンネル (ホワイトリスト未設定時に有効) */
  hiddenChannelIds: string[];
  /** Web表示モード (リストが空でも編集を続けられるように保存する。未保存なら undefined) */
  visibilityMode?: "all" | "whitelist" | "hidden";
  /** Webサイトのサイドバー下段に寄せるカテゴリ */
  bottomChannelCategoryIds: string[];
  /** 設定の編集を許可するロール (空ならサーバー管理権限のみ) */
  setupManagerRoleIds: string[];
  /** 初回セットアップウィザードを完了済みか */
  setupDone: boolean;
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry)).filter((entry) => /^\d+$/.test(entry));
}

export function readDisplaySettings(config: GuildConfigWithDisplay): DisplaySettings {
  const raw = config.displayConfig ?? {};
  const mode = raw.visibilityMode;
  return {
    privateChatLabel:
      typeof raw.privateChatLabel === "string" && raw.privateChatLabel.trim()
        ? raw.privateChatLabel.trim()
        : "その他",
    privateChatCategoryIds: idList(raw.privateChatCategoryIds),
    whitelistChannelIds: idList(raw.whitelistChannelIds),
    hiddenChannelIds: idList(raw.hiddenChannelIds),
    visibilityMode: mode === "all" || mode === "whitelist" || mode === "hidden" ? mode : undefined,
    bottomChannelCategoryIds: idList(raw.bottomChannelCategoryIds),
    setupManagerRoleIds: idList(raw.setupManagerRoleIds),
    setupDone: raw.setupDone === true,
  };
}

/** display_config にパッチをマージする (NULLでも動く) */
export async function mergeDisplayConfig(
  pool: Pool,
  guildId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `
    UPDATE guilds
    SET display_config = COALESCE(display_config, '{}'::jsonb) || $2::jsonb,
        updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = $1
    `,
    [guildId, JSON.stringify(patch)],
  );
}

interface GuildRow {
  guild_id: string | bigint;
  name: string;
  announce_channel_id: string | bigint | null;
  king_role_id: string | bigint | null;
  excluded_channel_ids: unknown;
  display_config: unknown;
  domains: string[] | null;
  primary_domains: string[] | null;
}

function normalizeId(value: string | bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return /^\d+$/.test(text) ? text : null;
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeId(entry as string | bigint))
    .filter((entry): entry is string => entry !== null);
}

function toGuildRow(row: GuildRow): GuildConfigWithDisplay {
  return {
    guildId: String(row.guild_id),
    name: row.name,
    announceChannelId: normalizeId(row.announce_channel_id),
    kingRoleId: normalizeId(row.king_role_id),
    excludedChannelIds: normalizeIds(row.excluded_channel_ids),
    displayConfig: (row.display_config as Record<string, unknown> | null) ?? null,
    domains: Array.isArray(row.domains) ? row.domains : [],
    primaryDomains: Array.isArray(row.primary_domains) ? row.primary_domains : [],
  };
}

const GUILD_SELECT_SQL = `
  SELECT g.guild_id, g.name, g.announce_channel_id, g.king_role_id,
         g.excluded_channel_ids, g.display_config,
         array_agg(d.domain ORDER BY d.domain) FILTER (WHERE d.domain IS NOT NULL AND d.is_active) AS domains,
         array_agg(d.domain ORDER BY d.domain) FILTER (WHERE d.is_primary AND d.domain IS NOT NULL AND d.is_active) AS primary_domains
  FROM guilds g
  LEFT JOIN guild_domains d ON d.guild_id = g.guild_id
  WHERE g.guild_id = $1
  GROUP BY g.guild_id`;

/** ギルド設定を取得する。未登録ギルドはnull */
export async function getGuildConfig(
  pool: Pool,
  guildId: string,
): Promise<GuildConfigWithDisplay | null> {
  const { rows } = await pool.query(GUILD_SELECT_SQL, [guildId]);
  return rows.length > 0 ? toGuildRow(rows[0] as GuildRow) : null;
}

/** キャッシュ済みギルドの名前・アイコンを登録し、アクティブ化する */
export async function upsertGuild(pool: Pool, guild: Guild): Promise<void> {
  await pool.query(
    `
    INSERT INTO guilds (guild_id, name, icon_url, is_active)
    VALUES ($1, $2, $3, TRUE)
    ON CONFLICT (guild_id) DO UPDATE
    SET name = EXCLUDED.name,
        icon_url = EXCLUDED.icon_url,
        is_active = TRUE,
        updated_at = CURRENT_TIMESTAMP
    `,
    [guild.id, guild.name, guild.iconURL()],
  );
  // 全ギルドに標準サブドメイン (<サーバーID>.yexe.top) を自動登録する。
  // ギルドIDは不変・一意のため失効チェックは不要 (source='guild')。
  await registerGuildIdSubdomain(pool, guild.id);
}

/** Botが退出したギルドを非アクティブ化する (データは保持する) */
export async function deactivateGuild(pool: Pool, guildId: string): Promise<void> {
  await pool.query(
    "UPDATE guilds SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE guild_id = $1",
    [guildId],
  );
  // 退出したギルドのダッシュボードドメインも無効化する
  await pool.query("UPDATE guild_domains SET is_active = FALSE WHERE guild_id = $1", [guildId]);
}

/** ギルドのダッシュボード標準サブドメイン (<サーバーID>.yexe.top) を登録する */
export async function registerGuildIdSubdomain(pool: Pool, guildId: string): Promise<void> {
  const baseDomain = (process.env.SUBDOMAIN_BASE_DOMAIN || "yexe.top").toLowerCase();
  await pool.query(
    `
    INSERT INTO guild_domains (domain, guild_id, source, invite_code, is_active)
    VALUES ($1, $2::bigint, 'guild', NULL, TRUE)
    ON CONFLICT (domain) DO UPDATE
    SET guild_id = EXCLUDED.guild_id, source = 'guild', is_active = TRUE
    `,
    [`${guildId}.${baseDomain}`, guildId],
  );
}

/** Botが参加中の全ギルドを登録する */
export async function syncGuildRegistry(pool: Pool, guilds: Iterable<Guild>): Promise<void> {
  for (const guild of guilds) {
    await upsertGuild(pool, guild);
  }
}

export interface GuildSetupRow {
  guildId: string;
  kingRoleId: string;
}

/** 発言王ロールが設定されたアクティブギルド一覧 */
export async function listKingRoleGuilds(pool: Pool): Promise<GuildSetupRow[]> {
  const { rows } = await pool.query(
    "SELECT guild_id, king_role_id FROM guilds WHERE king_role_id IS NOT NULL AND is_active",
  );
  return rows.flatMap((row) => {
    const guildId = normalizeId(row.guild_id as string | bigint);
    const roleId = normalizeId(row.king_role_id as string | bigint);
    return guildId && roleId ? [{ guildId, kingRoleId: roleId }] : [];
  });
}

export interface GuildAnnounceRow {
  guildId: string;
  announceChannelId: string;
  kingRoleId: string | null;
  excludedChannelIds: string[];
  domains: string[];
  primaryDomains: string[];
}

/** 月間ランキングを告知するチャンネルが設定されたアクティブギルド一覧 */
export async function listAnnounceGuilds(pool: Pool): Promise<GuildAnnounceRow[]> {
  const { rows } = await pool.query(
    `
    SELECT g.guild_id, g.announce_channel_id, g.king_role_id, g.excluded_channel_ids,
           array_agg(d.domain ORDER BY d.domain) FILTER (WHERE d.domain IS NOT NULL) AS domains,
           array_agg(d.domain ORDER BY d.domain) FILTER (WHERE d.is_primary AND d.domain IS NOT NULL) AS primary_domains
    FROM guilds g
    LEFT JOIN guild_domains d ON d.guild_id = g.guild_id
    WHERE g.announce_channel_id IS NOT NULL AND g.is_active
    GROUP BY g.guild_id`,
  );
  return rows.flatMap((row) => {
    const guildId = normalizeId(row.guild_id as string | bigint);
    const channelId = normalizeId(row.announce_channel_id as string | bigint);
    if (!guildId || !channelId) return [];
    return [
      {
        guildId,
        announceChannelId: channelId,
        kingRoleId: normalizeId(row.king_role_id as string | bigint),
        excludedChannelIds: normalizeIds(row.excluded_channel_ids),
        domains: Array.isArray(row.domains) ? row.domains : [],
        primaryDomains: Array.isArray(row.primary_domains) ? row.primary_domains : [],
      },
    ];
  });
}

function preferApex(domains: string[]): string | null {
  const apex = domains.find((entry) => !entry.startsWith("www."));
  return apex ?? domains[0] ?? null;
}

/** ギルドのダッシュボードURLを組み立てる (代表ドメイン優先、ドメイン未設定ならnull) */
export function dashboardUrl(
  config: Pick<GuildConfigRow, "domains" | "primaryDomains">,
  path: string,
): string | null {
  const domain = preferApex(config.primaryDomains) ?? preferApex(config.domains);
  if (!domain) return null;
  return `https://${domain}${path}`;
}
