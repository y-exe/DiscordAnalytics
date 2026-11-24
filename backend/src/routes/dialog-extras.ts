import type { Pool } from "pg";

/** カード拡大ポップアップ向けの派生集計 (リピーター分布・日別1位・最長メッセージ・新規メンバー) */

/** ユーザー別の期間内活動日数の分布 (1日だけ / 2-3日 / 4-7日 / 8日以上) */
export interface RepeatBuckets {
  one: number;
  two_three: number;
  four_seven: number;
  eight_plus: number;
}

/** 日ごとの最多発言者 */
export interface LeaderEntry {
  date: string;
  user_id: string;
  display_name: string;
  count: number;
}

/** 期間内で最も文字数の多いメッセージ */
export interface LongestMessage {
  chars: number;
  user_id: string;
  display_name: string;
  date: string;
  channel_name?: string;
}

const DELETED =
  "(u.user_id IS NOT NULL AND u.username NOT ILIKE 'deleted%user' AND u.display_name NOT ILIKE 'deleted%user')";

type Row = Record<string, unknown>;

async function queryRows(pool: Pool, sql: string, params: unknown[]): Promise<Row[]> {
  const { rows } = await pool.query(sql, params);
  return rows as Row[];
}

/**
 * where 内の無修飾 guild_id を m.guild_id に置換する。
 * 呼び出し側の where は既に m エイリアス付きで渡されるが、guild_id だけは
 * 呼び出し元のフィルタ構築の都合で無修飾のまま残るため、ここで揃える。
 * (guild_members/users にも guild_id があるため修飾しないと曖昧になる)
 */
function withMGuildId(where: string): string {
  // 既に m. が付いている参照はそのまま残し、無修飾の guild_id だけを置換する
  return where.replace(/(?<!m\.)guild_id/g, "m.guild_id");
}

/**
 * ユーザー別の期間内活動日数をバケット化する (リピーター分析)。
 * where は m エイリアス付きの完全なフィルタ (期間・guild・scope を含む)。
 */
export async function repeatBuckets(
  pool: Pool,
  where: string,
  params: unknown[],
): Promise<RepeatBuckets> {
  const result: RepeatBuckets = { one: 0, two_three: 0, four_seven: 0, eight_plus: 0 };
  const rows = await queryRows(
    pool,
    [
      "WITH ud AS (",
      "  SELECT m.user_id, count(DISTINCT DATE(m.created_at AT TIME ZONE 'Asia/Tokyo')) AS days",
      "  FROM messages m",
      "  LEFT JOIN users u ON u.user_id = m.user_id",
      "  WHERE " + withMGuildId(where) + " AND " + DELETED,
      "  GROUP BY m.user_id",
      ")",
      "SELECT CASE WHEN days = 1 THEN 'one' WHEN days <= 3 THEN 'two_three'",
      "            WHEN days <= 7 THEN 'four_seven' ELSE 'eight_plus' END AS bucket,",
      "       count(*)::int AS n",
      "FROM ud GROUP BY 1",
    ].join("\n"),
    params,
  );
  for (const row of rows) {
    const bucket = String(row.bucket);
    const n = Number(row.n ?? 0);
    if (bucket === "one") result.one = n;
    else if (bucket === "two_three") result.two_three = n;
    else if (bucket === "four_seven") result.four_seven = n;
    else if (bucket === "eight_plus") result.eight_plus = n;
  }
  return result;
}

/** 日ごとの最多発言者 (同数の場合は user_id 順で決定的に) */
export async function leadersPerDay(
  pool: Pool,
  where: string,
  params: unknown[],
): Promise<LeaderEntry[]> {
  const rows = await queryRows(
    pool,
    [
      "SELECT d::text AS date, user_id::text AS user_id, display_name, c::int AS count FROM (",
      "  SELECT DATE(m.created_at AT TIME ZONE 'Asia/Tokyo') AS d, m.user_id,",
      "         COALESCE(gm.display_name, u.display_name, u.username) AS display_name,",
      "         count(*) AS c,",
      "         row_number() OVER (",
      "           PARTITION BY DATE(m.created_at AT TIME ZONE 'Asia/Tokyo')",
      "           ORDER BY count(*) DESC, m.user_id",
      "         ) AS rn",
      "  FROM messages m",
      "  LEFT JOIN guild_members gm ON gm.guild_id = m.guild_id AND gm.user_id = m.user_id",
      "  LEFT JOIN users u ON u.user_id = m.user_id",
      "  WHERE " + withMGuildId(where) + " AND " + DELETED,
      "  GROUP BY 1, 2, 3",
      ") t WHERE rn = 1 ORDER BY d",
    ].join("\n"),
    params,
  );
  return rows.map((row) => ({
    date: String(row.date),
    user_id: String(row.user_id),
    display_name: String(row.display_name ?? "Unknown"),
    count: Number(row.count ?? 0),
  }));
}

/** 期間内で最も文字数の多いメッセージ。withChannel でチャンネル名も返す */
export async function longestMessage(
  pool: Pool,
  where: string,
  params: unknown[],
  opts: { withChannelName?: boolean } = {},
): Promise<LongestMessage | null> {
  const channelJoin = opts.withChannelName
    ? "LEFT JOIN channels ch ON ch.channel_id = m.channel_id AND ch.guild_id = m.guild_id"
    : "";
  const rows = await queryRows(
    pool,
    [
      "SELECT m.char_count, m.user_id::text AS user_id,",
      "       COALESCE(gm.display_name, u.display_name, u.username) AS display_name,",
      "       DATE(m.created_at AT TIME ZONE 'Asia/Tokyo')::text AS d",
      opts.withChannelName ? ", ch.name AS channel_name" : "",
      " FROM messages m",
      " LEFT JOIN guild_members gm ON gm.guild_id = m.guild_id AND gm.user_id = m.user_id",
      " LEFT JOIN users u ON u.user_id = m.user_id",
      channelJoin,
      " WHERE " + withMGuildId(where) + " AND " + DELETED + " AND m.char_count > 0",
      " ORDER BY m.char_count DESC",
      " LIMIT 1",
    ]
      .join("\n")
      .replace("\n\n", "\n"),
    params,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    chars: Number(row.char_count ?? 0),
    user_id: String(row.user_id ?? ""),
    display_name: String(row.display_name ?? "Unknown"),
    date: String(row.d ?? ""),
    ...(opts.withChannelName && row.channel_name ? { channel_name: String(row.channel_name) } : {}),
  };
}

/**
 * 期間内に初めて発言したメンバー数。
 * scopeClause/scopeParams がある場合はそのスコープ内での初発言 (例: チャンネルに初めて書いた人)。
 * 無指定なら guild 全体での初発言。
 */
export async function newMembersCount(
  pool: Pool,
  opts: {
    guildId: string;
    start: string | Date;
    end: string | Date;
    scopeClause?: string;
    scopeParams?: unknown[];
  },
): Promise<number> {
  const params: unknown[] = [opts.guildId, opts.start, opts.end, ...(opts.scopeParams ?? [])];
  const scope = opts.scopeClause ? "AND " + opts.scopeClause : "";
  const rows = await queryRows(
    pool,
    [
      "SELECT count(*)::int AS n FROM (",
      "  SELECT m.user_id, MIN(m.created_at) AS first_at",
      "  FROM messages m",
      "  LEFT JOIN users u ON u.user_id = m.user_id",
      "  WHERE m.guild_id = $1 AND m.is_bot = FALSE " + scope + " AND " + DELETED,
      "  GROUP BY m.user_id",
      "  HAVING MIN(m.created_at) >= $2 AND MIN(m.created_at) < $3",
      ") t",
    ].join("\n"),
    params,
  );
  return Number(rows[0]?.n ?? 0);
}
