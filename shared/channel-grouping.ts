/**
 * チャンネルのグルーピングに関する共有定数 (Botの書き込み側とbackendの読み取り側で共用)。
 */

/** Discordのカテゴリに属さないチャンネルに付く分類名 (sync/loggerが設定する) */
export const UNCATEGORIZED_LABEL = "未分類";

/** スレッドのDB上の名前 «親チャンネル名 / スレッド名» の区切り */
export const THREAD_NAME_SEPARATOR = " / ";

/** 集約チャンネルのダミーID (フロントエンドと共有される慣習的な値) */
export const AGGREGATED_CHANNEL_ID = "-1";
