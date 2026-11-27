/**
 * チャンネルのグルーピング定義 (集約チャンネル「ラベル総合」+ スレッドの親集約)。
 *
 * 「選択カテゴリ (display_config.privateChatCategoryIds) = 個別表示、
 *   それ以外のチャンネル = ラベル総合に集約」という判定を SQL・JS の両方で
 * 1箇所にまとめる。routes/channels.ts・routes/context.ts・routes/stats.ts で共用。
 * 定数は shared/channel-grouping.ts (Botの書き込み側と共用)。
 */
import { UNCATEGORIZED_LABEL, THREAD_NAME_SEPARATOR } from "../../shared/channel-grouping";

export { UNCATEGORIZED_LABEL, THREAD_NAME_SEPARATOR };

export interface ChannelRowLike {
  category_id?: unknown;
  category_name?: unknown;
  name?: unknown;
  channel_id?: unknown;
}

/**
 * JS側: このチャンネル行が集約対象 (ラベル総合に含まれる) か。
 * - カテゴリなし (category_id = NULL) は「未分類」のみ集約対象
 * - カテゴリありは privateChatCategoryIds に含まれない (個別表示でない) もの
 */
export function isAggregatedChannelRow(
  row: ChannelRowLike,
  privateChatCategoryIds: readonly string[],
): boolean {
  const categoryId =
    row.category_id === null || row.category_id === undefined ? null : String(row.category_id);
  if (categoryId === null) return row.category_name === UNCATEGORIZED_LABEL;
  return !privateChatCategoryIds.includes(categoryId);
}

/**
 * SQL側: 集約対象チャンネルの WHERE 条件。
 * isAggregatedChannelRow と同じ意味 (columnsはエイリアス付きで参照する)。
 * 例: aggregatedChannelSqlCondition("c", "$2::bigint[]")
 */
export function aggregatedChannelSqlCondition(alias: string, categoriesParam: string): string {
  return (
    `((${alias}.category_id IS NULL AND ${alias}.category_name = '${UNCATEGORIZED_LABEL}')` +
    ` OR (${alias}.category_id IS NOT NULL AND NOT (${alias}.category_id = ANY(${categoriesParam}))))`
  );
}

/**
 * SQL側: 個別チャンネルの表示名 (スレッドは «親名 / スレ名» を親名に畳む)。
 */
export function channelDisplayNameSql(alias: string): string {
  return (
    `CASE WHEN ${alias}.name LIKE '%${THREAD_NAME_SEPARATOR}%'` +
    ` THEN btrim(split_part(${alias}.name, '/', 1)) ELSE ${alias}.name END`
  );
}

/**
 * スレッド («親名 / スレ名» 形式の行) を親チャンネルIDへ集約するマップを作る。
 * key = スレッドのchannel_id, value = 親チャンネルのchannel_id
 */
export function buildThreadParentMap(rows: ChannelRowLike[]): Map<string, string> {
  const nameToId = new Map<string, string>();
  for (const row of rows) nameToId.set(String(row.name), String(row.channel_id));
  const parentIdOf = new Map<string, string>();
  for (const row of rows) {
    const name = String(row.name);
    const sep = name.indexOf(THREAD_NAME_SEPARATOR);
    if (sep <= 0) continue;
    const parent = nameToId.get(name.slice(0, sep));
    if (parent && parent !== String(row.channel_id)) {
      parentIdOf.set(String(row.channel_id), parent);
    }
  }
  return parentIdOf;
}
