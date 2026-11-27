import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Pool } from "pg";
import { leadersPerDay, longestMessage, newMembersCount, repeatBuckets } from "./dialog-extras";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_LOGIN_LIMIT,
  ADMIN_LOGIN_WINDOW,
  adminClientKey,
  adminOriginAllowed,
  adminSessionCookie,
  adminSessionCookieDeletion,
  createAdminSession,
  isApiClient,
  verifyAdminSession,
} from "../adminAuth";
import {
  DELETED_USER_FILTER,
  LIVE_TOTAL_CACHE_TTL,
  TOTAL_CACHE_WARM_INTERVAL_MS,
  addChannelScopeFilter,
  computeUserIdsKey,
  escapeLike,
  formatRankingResponse,
  formatUserRankResponse,
  jsonResponse,
  jsonError,
  monthBounds,
  noContent,
  parseEndDate,
  pathInt,
  plainTextResponse,
  readBodyCapped,
} from "../http";
import { channelDisplayNameSql } from "../channelGrouping";
import { dashboardBaseUrl, normalizeHost } from "../guilds";
import type { AppEnv } from "../types";
import type { RouteHelpers } from "./context";

/** 統計 (/stats/*) */
export function register(app: Hono<AppEnv>, h: RouteHelpers): void {
  const {
    cfg,
    cache,
    deps,
    getPeerIp,
    requireGuild,
    getChannelScopeIds,
    requireMonthAccess,
    monthCacheControl,
  } = h;

  app.get("/stats/history/:year/:month", async (c) => {
    const year = pathInt(c.req.param("year"));
    const month = pathInt(c.req.param("month"));
    if (year === null || month === null) return jsonError(422, "Invalid path parameter");

    const userIds = c.req.queries("user_id") ?? [];
    if (userIds.length > 5) {
      return jsonError(400, "At most 5 user_id values are allowed");
    }

    const access = requireMonthAccess(c, year, month);
    if ("error" in access) return access.error;

    const channelParam = c.req.query("channel_id");
    if (channelParam !== undefined && !/^-?\d+$/.test(channelParam)) {
      return jsonError(422, "Invalid query parameter: channel_id");
    }
    const channelId = channelParam ?? null;

    const guildOrError = await requireGuild(c);
    if (guildOrError instanceof Response) return guildOrError;
    const guild = guildOrError;

    const ckey = `hist2_m_${guild.guildId}_${year}_${month}_${channelId ?? "None"}_${computeUserIdsKey(userIds)}`;
    const headers = monthCacheControl(access.isRestricted);
    const cached = cache.get(ckey);
    if (cached !== undefined) return jsonResponse(cached, 200, headers);

    const bounds = monthBounds(year, month);
    if (!Array.isArray(bounds)) return jsonError(400, bounds);
    const [startDate, endDate] = bounds;

    const pool = deps.getPool();
    if (!pool) return jsonError(503, "Service unavailable.");
    const scope = await getChannelScopeIds(pool, guild, channelId);
    if (scope instanceof Response) return scope;

    const params: unknown[] = [startDate, endDate];
    const filters = ["created_at >= $1", "created_at < $2", "is_bot = FALSE"];
    params.push(guild.guildId);
    filters.push(`guild_id = $${params.length}`);
    addChannelScopeFilter(params, filters, "channel_id", scope);
    const where = filters.join(" AND ");

    const { rows: tRows } = await pool.query(
      `SELECT DATE(created_at) as d, count(*) as c, count(DISTINCT user_id) AS u, COALESCE(sum(char_count), 0) AS chars FROM messages WHERE ${where} GROUP BY DATE(created_at)`,
      params,
    );
    // user_id指定なしはサマリー用ライトモード: 重い上位ユーザー内訳をスキップ (比較ページは従来通りフル)
    const topU: Record<string, unknown>[] = [];
    if (userIds.length > 0) {
      const topWhere = where
        .replaceAll("channel_id", "m.channel_id")
        .replaceAll("created_at", "m.created_at")
        .replaceAll("is_bot", "m.is_bot");
      const { rows } = await pool.query(
        `SELECT m.user_id, count(*) as c FROM messages m LEFT JOIN users u ON m.user_id = u.user_id WHERE ${topWhere} AND ${DELETED_USER_FILTER} GROUP BY m.user_id ORDER BY c DESC LIMIT 100`,
        params,
      );
      topU.push(...rows);
    }

    const targetIds = topU.map((row) => String(row.user_id));
    for (const uid of userIds) {
      if (/^\d+$/.test(uid) && !targetIds.includes(uid)) targetIds.push(uid);
    }

    const dataMap = new Map<string, Record<string, unknown>>();
    for (const row of tRows) {
      const date = String(row.d);
      dataMap.set(date, {
        date,
        total: Number(row.c),
        users: Number(row.u ?? 0),
        chars: Number(row.chars ?? 0),
      });
    }
    const uDetails: Record<string, Record<string, unknown>> = {};
    if (targetIds.length > 0) {
      const detailParams = [...params, targetIds];
      const { rows } = await pool.query(
        `SELECT DATE(created_at) as d, user_id, count(*) as c FROM messages WHERE ${where} AND user_id = ANY($${detailParams.length}::bigint[]) GROUP BY DATE(created_at), user_id`,
        detailParams,
      );
      for (const row of rows) {
        const date = String(row.d);
        if (!dataMap.has(date)) dataMap.set(date, { date, total: 0 });
        dataMap.get(date)![String(row.user_id)] = Number(row.c);
      }
      const { rows: uRows } = await pool.query(
        "SELECT user_id, display_name, username, avatar_url FROM users WHERE user_id = ANY($1::bigint[])",
        [targetIds],
      );
      for (const row of uRows) {
        uDetails[String(row.user_id)] = {
          name: row.display_name,
          username: row.username,
          avatar: row.avatar_url,
        };
      }
    }

    const chartData = [...dataMap.values()].sort((a, b) =>
      String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0,
    );
    const res = {
      chart_data: chartData,
      users: uDetails,
      top_user_id: topU.length > 0 ? String(topU[0].user_id) : null,
    };
    cache.set(ckey, res, 600);
    return jsonResponse(res, 200, headers);
  });

  app.get("/stats/history/total", async (c) => {
    const userIds = c.req.queries("user_id") ?? [];
    if (userIds.length > 5) {
      return jsonError(400, "At most 5 user_id values are allowed");
    }
    const channelParam = c.req.query("channel_id");
    if (channelParam !== undefined && !/^-?\d+$/.test(channelParam)) {
      return jsonError(422, "Invalid query parameter: channel_id");
    }
    const channelId = channelParam ?? null;
    const endRaw = c.req.query("end_date");
    const endDate = parseEndDate(endRaw);
    if (endDate === "invalid") return jsonError(422, "Invalid query parameter: end_date");

    const ttl = endDate ? 86400 : LIVE_TOTAL_CACHE_TTL;
    const headers = { "Cache-Control": `public, max-age=${ttl}` };
    const guildOrError = await requireGuild(c);
    if (guildOrError instanceof Response) return guildOrError;
    const guild = guildOrError;
    const ckey = `hist2_t_${guild.guildId}_${channelId ?? "None"}_${computeUserIdsKey(userIds)}_${endRaw ?? "None"}`;
    const cached = cache.get(ckey);
    if (cached !== undefined) return jsonResponse(cached, 200, headers);

    const pool = deps.getPool();
    if (!pool) return jsonError(503, "Service unavailable.");
    const scope = await getChannelScopeIds(pool, guild, channelId);
    if (scope instanceof Response) return scope;

    const params: unknown[] = [];
    const filters = ["is_bot = FALSE"];
    params.push(guild.guildId);
    filters.push(`guild_id = $${params.length}`);
    addChannelScopeFilter(params, filters, "channel_id", scope);
    if (endDate) {
      params.push(endDate);
      filters.push(`created_at <= $${params.length}`);
    }
    const where = filters.join(" AND ");

    const { rows: tRows } = await pool.query(
      `SELECT DATE(created_at) as d, count(*) as c, count(DISTINCT user_id) AS u, COALESCE(sum(char_count), 0) AS chars FROM messages WHERE ${where} GROUP BY DATE(created_at)`,
      params,
    );
    // user_id指定なしは期間ピッカー用ライトモード: 上位ユーザー内訳をスキップ
    const topU: Record<string, unknown>[] = [];
    if (userIds.length > 0) {
      const lineWhere = where
        .replaceAll("channel_id", "m.channel_id")
        .replaceAll("created_at", "m.created_at");
      const { rows } = await pool.query(
        `SELECT m.user_id, count(*) as c FROM messages m LEFT JOIN users u ON m.user_id = u.user_id WHERE ${lineWhere} AND ${DELETED_USER_FILTER} GROUP BY m.user_id ORDER BY c DESC LIMIT 100`,
        params,
      );
      topU.push(...rows);
    }

    const targetIds = topU.map((row) => String(row.user_id));
    for (const uid of userIds) {
      if (/^\d+$/.test(uid) && !targetIds.includes(uid)) targetIds.push(uid);
    }

    const dataMap = new Map<string, Record<string, unknown>>();
    for (const row of tRows) {
      const date = String(row.d);
      dataMap.set(date, {
        date,
        total: Number(row.c),
        users: Number(row.u ?? 0),
        chars: Number(row.chars ?? 0),
      });
    }
    const uDetails: Record<string, Record<string, unknown>> = {};
    if (targetIds.length > 0) {
      const detailParams = [...params, targetIds];
      const { rows } = await pool.query(
        `SELECT DATE(created_at) as d, user_id, count(*) as c FROM messages WHERE ${where} AND user_id = ANY($${detailParams.length}::bigint[]) GROUP BY DATE(created_at), user_id`,
        detailParams,
      );
      for (const row of rows) {
        const date = String(row.d);
        if (!dataMap.has(date)) dataMap.set(date, { date, total: 0 });
        dataMap.get(date)![String(row.user_id)] = Number(row.c);
      }
      const { rows: uRows } = await pool.query(
        "SELECT user_id, display_name, username, avatar_url FROM users WHERE user_id = ANY($1::bigint[])",
        [targetIds],
      );
      for (const row of uRows) {
        uDetails[String(row.user_id)] = {
          name: row.display_name,
          username: row.username,
          avatar: row.avatar_url,
        };
      }
    }

    const chartData = [...dataMap.values()].sort((a, b) =>
      String(a.date) < String(b.date) ? -1 : String(b.date) < String(a.date) ? 1 : 0,
    );
    const res = {
      chart_data: chartData,
      users: uDetails,
      top_user_id: topU.length > 0 ? String(topU[0].user_id) : null,
    };
    cache.set(ckey, res, ttl);
    return jsonResponse(res, 200, headers);
  });

  app.get("/stats/heatmap/:year/:month", async (c) => {
    const year = pathInt(c.req.param("year"));
    const month = pathInt(c.req.param("month"));
    if (year === null || month === null) return jsonError(422, "Invalid path parameter");

    const access = requireMonthAccess(c, year, month);
    if ("error" in access) return access.error;

    const channelParam = c.req.query("channel_id");
    if (channelParam !== undefined && !/^-?\d+$/.test(channelParam)) {
      return jsonError(422, "Invalid query parameter: channel_id");
    }
    const channelId = channelParam ?? null;

    const guildOrError = await requireGuild(c);
    if (guildOrError instanceof Response) return guildOrError;
    const guild = guildOrError;

    const ckey = `heat_m_${guild.guildId}_${year}_${month}_${channelId ?? "None"}`;
    const headers = monthCacheControl(access.isRestricted);
    const cached = cache.get(ckey);
    if (cached !== undefined) return jsonResponse(cached, 200, headers);

    const bounds = monthBounds(year, month);
    if (!Array.isArray(bounds)) return jsonError(400, bounds);
    const [startDate, endDate] = bounds;

    const pool = deps.getPool();
    if (!pool) return jsonError(503, "Service unavailable.");
    const scope = await getChannelScopeIds(pool, guild, channelId);
    if (scope instanceof Response) return scope;

    const params: unknown[] = [startDate, endDate];
    const filters = ["created_at >= $1", "created_at < $2", "is_bot = FALSE"];
    params.push(guild.guildId);
    filters.push(`guild_id = $${params.length}`);
    addChannelScopeFilter(params, filters, "channel_id", scope);

    const { rows } = await pool.query(
      `SELECT EXTRACT(DOW FROM created_at AT TIME ZONE 'Asia/Tokyo') as dow, EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Tokyo') as hour, count(*) as count FROM messages WHERE ${filters.join(" AND ")} GROUP BY dow, hour`,
      params,
    );
    const res = rows.map((row) => ({
      dow: Number(row.dow),
      hour: Number(row.hour),
      count: Number(row.count),
    }));
    cache.set(ckey, res, 600);
    return jsonResponse(res, 200, headers);
  });

  app.get("/stats/heatmap/total", async (c) => {
    const channelParam = c.req.query("channel_id");
    if (channelParam !== undefined && !/^-?\d+$/.test(channelParam)) {
      return jsonError(422, "Invalid query parameter: channel_id");
    }
    const channelId = channelParam ?? null;
    const endRaw = c.req.query("end_date");
    const endDate = parseEndDate(endRaw);
    if (endDate === "invalid") return jsonError(422, "Invalid query parameter: end_date");

    const ttl = endDate ? 86400 : LIVE_TOTAL_CACHE_TTL;
    const headers = { "Cache-Control": `public, max-age=${ttl}` };
    const guildOrError = await requireGuild(c);
    if (guildOrError instanceof Response) return guildOrError;
    const guild = guildOrError;
    const ckey = `heat_t_${guild.guildId}_${channelId ?? "None"}_${endRaw ?? "None"}`;
    const cached = cache.get(ckey);
    if (cached !== undefined) return jsonResponse(cached, 200, headers);

    const pool = deps.getPool();
    if (!pool) return jsonError(503, "Service unavailable.");
    const scope = await getChannelScopeIds(pool, guild, channelId);
    if (scope instanceof Response) return scope;

    const params: unknown[] = [];
    const filters = ["is_bot = FALSE"];
    params.push(guild.guildId);
    filters.push(`guild_id = $${params.length}`);
    addChannelScopeFilter(params, filters, "channel_id", scope);
    if (endDate) {
      params.push(endDate);
      filters.push(`created_at <= $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT EXTRACT(DOW FROM created_at AT TIME ZONE 'Asia/Tokyo') as dow, EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Tokyo') as hour, count(*) as count FROM messages WHERE ${filters.join(" AND ")} GROUP BY dow, hour`,
      params,
    );
    const res = rows.map((row) => ({
      dow: Number(row.dow),
      hour: Number(row.hour),
      count: Number(row.count),
    }));
    cache.set(ckey, res, ttl);
    return jsonResponse(res, 200, headers);
  });

  app.get("/stats/channels_distribution/:year/:month", async (c) => {
    const year = pathInt(c.req.param("year"));
    const month = pathInt(c.req.param("month"));
    if (year === null || month === null) return jsonError(422, "Invalid path parameter");

    const access = requireMonthAccess(c, year, month);
    if ("error" in access) return access.error;

    const guildOrError = await requireGuild(c);
    if (guildOrError instanceof Response) return guildOrError;
    const guild = guildOrError;

    const ckey = `pie_m_${guild.guildId}_${year}_${month}`;
    const headers = monthCacheControl(access.isRestricted);
    const cached = cache.get(ckey);
    if (cached !== undefined) return jsonResponse(cached, 200, headers);

    const bounds = monthBounds(year, month);
    if (!Array.isArray(bounds)) return jsonError(400, bounds);
    const [startDate, endDate] = bounds;

    const pool = deps.getPool();
    if (!pool) return jsonError(503, "Service unavailable.");
    const privateChatCategoryIds = guild.displayConfig.privateChatCategoryIds;
    const { rows } = await pool.query(
      privateChatCategoryIds.length > 0
        ? `
      SELECT
          CASE
              WHEN c.category_id = ANY($3::bigint[]) THEN
                  (${channelDisplayNameSql("c")})
              ELSE $5::text
          END AS name,
          count(*) AS count
      FROM messages m
      JOIN channels c ON m.channel_id = c.channel_id
      WHERE m.created_at >= $1 AND m.created_at < $2 AND m.is_bot = FALSE AND m.guild_id = $4
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 10
      `
        : `
      SELECT ${channelDisplayNameSql("c")} AS name, count(*) AS count
      FROM messages m
      JOIN channels c ON m.channel_id = c.channel_id
      WHERE m.created_at >= $1 AND m.created_at < $2 AND m.is_bot = FALSE AND m.guild_id = $3
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 10
      `,
      privateChatCategoryIds.length > 0
        ? [
            startDate,
            endDate,
            privateChatCategoryIds,
            guild.guildId,
            guild.displayConfig.privateChatLabel,
          ]
        : [startDate, endDate, guild.guildId],
    );
    const res = rows.map((row) => ({ name: row.name as string, value: Number(row.count) }));
    cache.set(ckey, res, 600);
    return jsonResponse(res, 200, headers);
  });

  app.get("/stats/channels_distribution/total", async (c) => {
    const endRaw = c.req.query("end_date");
    const endDate = parseEndDate(endRaw);
    if (endDate === "invalid") return jsonError(422, "Invalid query parameter: end_date");

    const ttl = endDate ? 86400 : LIVE_TOTAL_CACHE_TTL;
    const headers = { "Cache-Control": `public, max-age=${ttl}` };
    const guildOrError = await requireGuild(c);
    if (guildOrError instanceof Response) return guildOrError;
    const guild = guildOrError;
    const ckey = `pie_t_${guild.guildId}_${endRaw ?? "None"}`;
    const cached = cache.get(ckey);
    if (cached !== undefined) return jsonResponse(cached, 200, headers);

    const pool = deps.getPool();
    if (!pool) return jsonError(503, "Service unavailable.");
    const privateChatCategoryIds = guild.displayConfig.privateChatCategoryIds;
    const params: unknown[] = privateChatCategoryIds.length > 0 ? [privateChatCategoryIds] : [];
    const filters = ["m.is_bot = FALSE"];
    params.push(guild.guildId);
    filters.push(`m.guild_id = $${params.length}`);
    if (endDate) {
      params.push(endDate);
      filters.push(`m.created_at <= $${params.length}`);
    }
    const labelParam = `$${params.length + 1}::text`;
    if (privateChatCategoryIds.length > 0) params.push(guild.displayConfig.privateChatLabel);

    const { rows } = await pool.query(
      privateChatCategoryIds.length > 0
        ? `
      SELECT
          CASE
              WHEN c.category_id = ANY($1::bigint[]) THEN
                  (${channelDisplayNameSql("c")})
              ELSE ${labelParam}
          END AS name,
          count(*) AS count
      FROM messages m
      JOIN channels c ON m.channel_id = c.channel_id
      WHERE ${filters.join(" AND ")}
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 10
      `
        : `
      SELECT ${channelDisplayNameSql("c")} AS name, count(*) AS count
      FROM messages m
      JOIN channels c ON m.channel_id = c.channel_id
      WHERE ${filters.join(" AND ")}
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 10
      `,
      params,
    );
    const res = rows.map((row) => ({ name: row.name as string, value: Number(row.count) }));
    cache.set(ckey, res, ttl);
    return jsonResponse(res, 200, headers);
  });

  app.get("/stats/analysis/:year/:month", async (c) => {
    const year = pathInt(c.req.param("year"));
    const month = pathInt(c.req.param("month"));
    if (year === null || month === null) return jsonError(422, "Invalid path parameter");

    const access = requireMonthAccess(c, year, month);
    if ("error" in access) return access.error;

    const channelParam = c.req.query("channel_id");
    if (channelParam !== undefined && !/^-?\d+$/.test(channelParam)) {
      return jsonError(422, "Invalid query parameter: channel_id");
    }
    const channelId = channelParam ?? null;
    const userParam = c.req.query("user_id");
    if (userParam !== undefined && userParam.length > 20) {
      return jsonError(422, "Invalid query parameter: user_id");
    }
    // extras=0: ポップアップ用の派生集計を省いたカード表示用レスポンス。
    // 完全版 (x1) がキャッシュにあればそこから派生する。
    const withExtras = c.req.query("extras") !== "0";

    const guildOrError = await requireGuild(c);
    if (guildOrError instanceof Response) return guildOrError;
    const guild = guildOrError;

    const ckeyBase = `ana_m_${guild.guildId}_${year}_${month}_${channelId ?? "None"}_${userParam ?? "None"}`;
    const ckey = `${ckeyBase}_${withExtras ? "x1" : "x0"}`;
    const headers = monthCacheControl(access.isRestricted);
    const cached = cache.get(ckey);
    if (cached !== undefined) return jsonResponse(cached, 200, headers);
    if (!withExtras) {
      const full = cache.get(`${ckeyBase}_x1`);
      if (full !== undefined) {
        const stripped = {
          ...(full as Record<string, unknown>),
          new_members: 0,
          repeat: null,
          longest_message: null,
          leaders: [],
        };
        cache.set(ckey, stripped, 600);
        return jsonResponse(stripped, 200, headers);
      }
    }

    const bounds = monthBounds(year, month);
    if (!Array.isArray(bounds)) return jsonError(400, bounds);
    const [startDate, endDate] = bounds;

    const pool = deps.getPool();
    if (!pool) return jsonError(503, "Service unavailable.");
    const scope = await getChannelScopeIds(pool, guild, channelId);
    if (scope instanceof Response) return scope;

    const params: unknown[] = [startDate, endDate];
    const filters = ["created_at >= $1", "created_at < $2", "is_bot = FALSE"];
    params.push(guild.guildId);
    filters.push(`guild_id = $${params.length}`);
    addChannelScopeFilter(params, filters, "channel_id", scope);
    if (userParam && /^\d+$/.test(userParam)) {
      params.push(userParam);
      filters.push(`user_id = $${params.length}`);
    }
    const where = filters.join(" AND ");

    const { rows: countRows } = await pool.query(
      `SELECT count(*) as total, COALESCE(sum(char_count), 0) as chars FROM messages WHERE ${where}`,
      params,
    );
    const total = Number(countRows[0]?.total ?? 0);
    if (total === 0)
      return jsonResponse(
        {
          total: 0,
          char_count: 0,
          new_members: 0,
          repeat: { one: 0, two_three: 0, four_seven: 0, eight_plus: 0 },
          longest_message: null,
          leaders: [],
        },
        200,
        headers,
      );
    const charCount = Number(countRows[0]?.chars ?? 0);

    const uniqueWhere = where
      .replaceAll("channel_id", "m.channel_id")
      .replaceAll("created_at", "m.created_at")
      .replaceAll("is_bot", "m.is_bot")
      .replaceAll("user_id", "m.user_id");
    const { rows: uniqueRows } = await pool.query(
      `
      SELECT count(DISTINCT m.user_id) AS unique_users
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.user_id
      WHERE ${uniqueWhere}
        AND ${DELETED_USER_FILTER}
      `,
      params,
    );
    const uniqueUsers = Number(uniqueRows[0]?.unique_users ?? 0);

    const { rows: maxDRows } = await pool.query(
      `SELECT DATE(created_at AT TIME ZONE 'Asia/Tokyo') as d, count(*) as c FROM messages WHERE ${where} GROUP BY d ORDER BY c DESC LIMIT 5`,
      params,
    );
    const { rows: maxWRows } = await pool.query(
      `SELECT EXTRACT(DOW FROM created_at AT TIME ZONE 'Asia/Tokyo') as dow, count(*) as c FROM messages WHERE ${where} GROUP BY dow ORDER BY c DESC LIMIT 1`,
      params,
    );
    const { rows: maxHRows } = await pool.query(
      `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Tokyo') as h, count(*) as c FROM messages WHERE ${where} GROUP BY h ORDER BY c DESC LIMIT 1`,
      params,
    );

    // ポップアップ用の派生集計 (リピーター分布・日別1位・最長メッセージ・新規メンバー)。
    // x0リクエストでも常に計算してx1キャッシュを作る (以降のx0は派生で済む)
    const [repeat, leaders, longest, newMembers] = await Promise.all([
      repeatBuckets(pool, uniqueWhere, params),
      leadersPerDay(pool, uniqueWhere, params),
      longestMessage(pool, uniqueWhere, params),
      newMembersCount(pool, { guildId: guild.guildId, start: startDate, end: endDate }),
    ]);

    const res = {
      total,
      char_count: charCount,
      unique_users: uniqueUsers,
      max_date: maxDRows[0] ? { date: String(maxDRows[0].d), count: Number(maxDRows[0].c) } : null,
      top_dates: maxDRows.map((row) => ({ date: String(row.d), count: Number(row.c) })),
      max_dow: maxWRows[0] ? { dow: Number(maxWRows[0].dow), count: Number(maxWRows[0].c) } : null,
      max_hour: maxHRows[0] ? { hour: Number(maxHRows[0].h), count: Number(maxHRows[0].c) } : null,
      new_members: newMembers,
      repeat,
      longest_message: longest,
      leaders,
    };
    cache.set(`${ckeyBase}_x1`, res, 600);
    if (withExtras) return jsonResponse(res, 200, headers);
    const stripped = { ...res, new_members: 0, repeat: null, longest_message: null, leaders: [] };
    cache.set(ckey, stripped, 600);
    return jsonResponse(stripped, 200, headers);
  });

  app.get("/stats/analysis/total", async (c) => {
    const channelParam = c.req.query("channel_id");
    if (channelParam !== undefined && !/^-?\d+$/.test(channelParam)) {
      return jsonError(422, "Invalid query parameter: channel_id");
    }
    const channelId = channelParam ?? null;
    const userParam = c.req.query("user_id");
    if (userParam !== undefined && userParam.length > 20) {
      return jsonError(422, "Invalid query parameter: user_id");
    }
    const endRaw = c.req.query("end_date");
    const endDate = parseEndDate(endRaw);
    if (endDate === "invalid") return jsonError(422, "Invalid query parameter: end_date");
    // extras=0: ポップアップ用の派生集計を省いたカード表示用レスポンス。
    // 完全版 (x1) がキャッシュにあればそこから派生するため重い集計を再実行しない。
    const withExtras = c.req.query("extras") !== "0";

    const ttl = endDate ? 86400 : LIVE_TOTAL_CACHE_TTL;
    const headers = { "Cache-Control": `public, max-age=${ttl}` };
    const guildOrError = await requireGuild(c);
    if (guildOrError instanceof Response) return guildOrError;
    const guild = guildOrError;
    const ckeyBase = `ana_t_${guild.guildId}_${channelId ?? "None"}_${userParam ?? "None"}_${endRaw ?? "None"}`;
    const ckey = `${ckeyBase}_${withExtras ? "x1" : "x0"}`;
    const cached = cache.get(ckey);
    if (cached !== undefined) return jsonResponse(cached, 200, headers);
    // extras=0 のリクエストでも完全版 (x1) が温まっていれば派生して即返す
    // (?m=all 初回のコールド集計 7秒問題の対策。ウォームループはx1を温める)
    if (!withExtras) {
      const full = cache.get(`${ckeyBase}_x1`);
      if (full !== undefined) {
        const stripped = {
          ...(full as Record<string, unknown>),
          repeat: null,
          longest_message: null,
          leaders: [],
        };
        cache.set(ckey, stripped, ttl);
        return jsonResponse(stripped, 200, headers);
      }
    }

    const pool = deps.getPool();
    if (!pool) return jsonError(503, "Service unavailable.");
    const scope = await getChannelScopeIds(pool, guild, channelId);
    if (scope instanceof Response) return scope;

    const params: unknown[] = [];
    const filters = ["is_bot = FALSE"];
    params.push(guild.guildId);
    filters.push(`guild_id = $${params.length}`);
    addChannelScopeFilter(params, filters, "channel_id", scope);
    if (userParam && /^\d+$/.test(userParam)) {
      params.push(userParam);
      filters.push(`user_id = $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      filters.push(`created_at <= $${params.length}`);
    }
    const where = filters.join(" AND ");

    const { rows: countRows } = await pool.query(
      `SELECT count(*) as total, COALESCE(sum(char_count), 0) as chars FROM messages WHERE ${where}`,
      params,
    );
    const total = Number(countRows[0]?.total ?? 0);
    if (total === 0)
      return jsonResponse(
        {
          total: 0,
          char_count: 0,
          new_members: 0,
          repeat: { one: 0, two_three: 0, four_seven: 0, eight_plus: 0 },
          longest_message: null,
          leaders: [],
        },
        200,
        headers,
      );
    const charCount = Number(countRows[0]?.chars ?? 0);

    const uniqueWhere = where
      .replaceAll("channel_id", "m.channel_id")
      .replaceAll("created_at", "m.created_at")
      .replaceAll("is_bot", "m.is_bot")
      .replaceAll("user_id", "m.user_id");
    const { rows: uniqueRows } = await pool.query(
      `
      SELECT count(DISTINCT m.user_id) AS unique_users
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.user_id
      WHERE ${uniqueWhere}
        AND ${DELETED_USER_FILTER}
      `,
      params,
    );
    const uniqueUsers = Number(uniqueRows[0]?.unique_users ?? 0);

    const { rows: maxDRows } = await pool.query(
      `SELECT DATE(created_at AT TIME ZONE 'Asia/Tokyo') as d, count(*) as c FROM messages WHERE ${where} GROUP BY d ORDER BY c DESC LIMIT 5`,
      params,
    );
    const { rows: maxWRows } = await pool.query(
      `SELECT EXTRACT(DOW FROM created_at AT TIME ZONE 'Asia/Tokyo') as dow, count(*) as c FROM messages WHERE ${where} GROUP BY dow ORDER BY c DESC LIMIT 1`,
      params,
    );
    const { rows: maxHRows } = await pool.query(
      `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Tokyo') as h, count(*) as c FROM messages WHERE ${where} GROUP BY h ORDER BY c DESC LIMIT 1`,
      params,
    );

    // ポップアップ用の派生集計 (全期間: 新規メンバーは比較対象がないためnull)。
    // x0リクエストでも常に計算してx1キャッシュを作る (以降のx0は派生で済む)
    const [repeat, leaders, longest] = await Promise.all([
      repeatBuckets(pool, uniqueWhere, params),
      leadersPerDay(pool, uniqueWhere, params),
      longestMessage(pool, uniqueWhere, params),
    ]);

    const res = {
      total,
      char_count: charCount,
      unique_users: uniqueUsers,
      max_date: maxDRows[0] ? { date: String(maxDRows[0].d), count: Number(maxDRows[0].c) } : null,
      top_dates: maxDRows.map((row) => ({ date: String(row.d), count: Number(row.c) })),
      max_dow: maxWRows[0] ? { dow: Number(maxWRows[0].dow), count: Number(maxWRows[0].c) } : null,
      max_hour: maxHRows[0] ? { hour: Number(maxHRows[0].h), count: Number(maxHRows[0].c) } : null,
      new_members: null,
      repeat,
      longest_message: longest,
      leaders,
    };
    cache.set(`${ckeyBase}_x1`, res, ttl);
    if (withExtras) return jsonResponse(res, 200, headers);
    const stripped = { ...res, repeat: null, longest_message: null, leaders: [] };
    cache.set(ckey, stripped, ttl);
    return jsonResponse(stripped, 200, headers);
  });

  /** ポップアップ用の派生集計 (リピーター分布・日別1位・最長メッセージ・新規メンバー)。
   *  /stats/analysis から分割したもので、カード表示には不要なためフロントは最後尾で取得する */
  app.get("/stats/analysis_extras/:year/:month", async (c) => {
    const year = pathInt(c.req.param("year"));
    const month = pathInt(c.req.param("month"));
    if (year === null || month === null) return jsonError(422, "Invalid path parameter");

    const access = requireMonthAccess(c, year, month);
    if ("error" in access) return access.error;

    const channelParam = c.req.query("channel_id");
    if (channelParam !== undefined && !/^-?\d+$/.test(channelParam)) {
      return jsonError(422, "Invalid query parameter: channel_id");
    }
    const channelId = channelParam ?? null;
    const userParam = c.req.query("user_id");
    if (userParam !== undefined && userParam.length > 20) {
      return jsonError(422, "Invalid query parameter: user_id");
    }

    const guildOrError = await requireGuild(c);
    if (guildOrError instanceof Response) return guildOrError;
    const guild = guildOrError;
    const ckey = `anaex_m_${guild.guildId}_${year}_${month}_${channelId ?? "None"}_${userParam ?? "None"}`;
    const headers = monthCacheControl(access.isRestricted);
    const cached = cache.get(ckey);
    if (cached !== undefined) return jsonResponse(cached, 200, headers);

    const bounds = monthBounds(year, month);
    if (!Array.isArray(bounds)) return jsonError(400, bounds);
    const [startDate, endDate] = bounds;

    const pool = deps.getPool();
    if (!pool) return jsonError(503, "Service unavailable.");
    const scope = await getChannelScopeIds(pool, guild, channelId);
    if (scope instanceof Response) return scope;

    const params: unknown[] = [startDate, endDate];
    const filters = ["created_at >= $1", "created_at < $2", "is_bot = FALSE"];
    params.push(guild.guildId);
    filters.push(`guild_id = $${params.length}`);
    addChannelScopeFilter(params, filters, "channel_id", scope);
    if (userParam && /^\d+$/.test(userParam)) {
      params.push(userParam);
      filters.push(`user_id = $${params.length}`);
    }
    const where = filters.join(" AND ");
    const uniqueWhere = where
      .replaceAll("channel_id", "m.channel_id")
      .replaceAll("created_at", "m.created_at")
      .replaceAll("is_bot", "m.is_bot")
      .replaceAll("user_id", "m.user_id");

    const [repeat, leaders, longest, newMembers] = await Promise.all([
      repeatBuckets(pool, uniqueWhere, params),
      leadersPerDay(pool, uniqueWhere, params),
      longestMessage(pool, uniqueWhere, params),
      newMembersCount(pool, { guildId: guild.guildId, start: startDate, end: endDate }),
    ]);

    const res = {
      new_members: newMembers,
      repeat,
      longest_message: longest,
      leaders,
    };
    cache.set(ckey, res, 600);
    return jsonResponse(res, 200, headers);
  });

  app.get("/stats/analysis_extras/total", async (c) => {
    const channelParam = c.req.query("channel_id");
    if (channelParam !== undefined && !/^-?\d+$/.test(channelParam)) {
      return jsonError(422, "Invalid query parameter: channel_id");
    }
    const channelId = channelParam ?? null;
    const userParam = c.req.query("user_id");
    if (userParam !== undefined && userParam.length > 20) {
      return jsonError(422, "Invalid query parameter: user_id");
    }
    const endRaw = c.req.query("end_date");
    const endDate = parseEndDate(endRaw);
    if (endDate === "invalid") return jsonError(422, "Invalid query parameter: end_date");

    const ttl = endDate ? 86400 : LIVE_TOTAL_CACHE_TTL;
    const headers = { "Cache-Control": `public, max-age=${ttl}` };
    const guildOrError = await requireGuild(c);
    if (guildOrError instanceof Response) return guildOrError;
    const guild = guildOrError;
    const ckey = `anaex_t_${guild.guildId}_${channelId ?? "None"}_${userParam ?? "None"}_${endRaw ?? "None"}`;
    const cached = cache.get(ckey);
    if (cached !== undefined) return jsonResponse(cached, 200, headers);

    const pool = deps.getPool();
    if (!pool) return jsonError(503, "Service unavailable.");
    const scope = await getChannelScopeIds(pool, guild, channelId);
    if (scope instanceof Response) return scope;

    const params: unknown[] = [];
    const filters = ["is_bot = FALSE"];
    params.push(guild.guildId);
    filters.push(`guild_id = $${params.length}`);
    addChannelScopeFilter(params, filters, "channel_id", scope);
    if (userParam && /^\d+$/.test(userParam)) {
      params.push(userParam);
      filters.push(`user_id = $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      filters.push(`created_at <= $${params.length}`);
    }
    const where = filters.join(" AND ");
    const uniqueWhere = where
      .replaceAll("channel_id", "m.channel_id")
      .replaceAll("created_at", "m.created_at")
      .replaceAll("is_bot", "m.is_bot")
      .replaceAll("user_id", "m.user_id");

    // 新規メンバーは比較対象がないためnull (月別と同じシェイプに揃える)
    const [repeat, leaders, longest] = await Promise.all([
      repeatBuckets(pool, uniqueWhere, params),
      leadersPerDay(pool, uniqueWhere, params),
      longestMessage(pool, uniqueWhere, params),
    ]);

    const res = {
      new_members: null,
      repeat,
      longest_message: longest,
      leaders,
    };
    cache.set(ckey, res, ttl);
    return jsonResponse(res, 200, headers);
  });

  /** チャンネル別統計 (前期間比較付き)。表示順は発言数降順 */
}
