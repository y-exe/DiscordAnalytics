import { describe, expect, test } from "bun:test";
import {
  UNCATEGORIZED_LABEL,
  aggregatedChannelSqlCondition,
  buildThreadParentMap,
  channelDisplayNameSql,
  isAggregatedChannelRow,
} from "../src/channelGrouping";

describe("isAggregatedChannelRow (ラベル総合への集約判定)", () => {
  const cats = ["100", "200"];

  test("選択カテゴリ配下は個別表示 (集約しない)", () => {
    expect(isAggregatedChannelRow({ category_id: 100, category_name: "雑談" }, cats)).toBe(false);
  });

  test("選択カテゴリ以外のカテゴリは集約する", () => {
    expect(isAggregatedChannelRow({ category_id: 300, category_name: "その他" }, cats)).toBe(true);
  });

  test("カテゴリなし (未分類) は集約する", () => {
    expect(
      isAggregatedChannelRow({ category_id: null, category_name: UNCATEGORIZED_LABEL }, cats),
    ).toBe(true);
  });

  test("カテゴリなしでも名前が未分類以外なら集約しない (従来互換)", () => {
    expect(isAggregatedChannelRow({ category_id: null, category_name: "特別" }, cats)).toBe(false);
  });

  test("category_idが文字列でも数値でも同じ判定になる", () => {
    expect(isAggregatedChannelRow({ category_id: "100", category_name: "雑談" }, cats)).toBe(false);
  });
});

describe("buildThreadParentMap (スレッドの親集約)", () => {
  test("«親名 / スレ名» を親チャンネルIDにマップする", () => {
    const rows = [
      { channel_id: 1, name: "親板" },
      { channel_id: 2, name: "親板 / スレA" },
      { channel_id: 3, name: "親板 / スレB" },
      { channel_id: 4, name: "別チャンネル" },
    ];
    const map = buildThreadParentMap(rows);
    expect(map.get("2")).toBe("1");
    expect(map.get("3")).toBe("1");
    expect(map.has("4")).toBe(false);
    expect(map.has("1")).toBe(false);
  });

  test("親が存在しないスレッド名は集約しない", () => {
    const rows = [{ channel_id: 5, name: "孤立 / スレ" }];
    expect(buildThreadParentMap(rows).size).toBe(0);
  });

  test("区切りだけの名前 (親名が空) は集約しない", () => {
    const rows = [
      { channel_id: 1, name: "親板" },
      { channel_id: 2, name: " / スレ" },
    ];
    expect(buildThreadParentMap(rows).size).toBe(0);
  });

  test("自分自身を親にしない", () => {
    const rows = [{ channel_id: 7, name: "自己参照 / X" }];
    const map = buildThreadParentMap(rows);
    // nameToId に「自己参照」が無いため集約されない
    expect(map.has("7")).toBe(false);
  });
});

describe("SQL断片", () => {
  test("aggregatedChannelSqlCondition がエイリアス付き条件を組み立てる", () => {
    const sql = aggregatedChannelSqlCondition("c", "$2::bigint[]");
    expect(sql).toContain("c.category_id IS NULL");
    expect(sql).toContain("c.category_name = '未分類'");
    expect(sql).toContain("NOT (c.category_id = ANY($2::bigint[]))");
  });

  test("channelDisplayNameSql がスレッド名を親名に畳む式を返す", () => {
    const sql = channelDisplayNameSql("c");
    expect(sql).toContain("c.name LIKE '% / %'");
    expect(sql).toContain("btrim(split_part(c.name, '/', 1))");
    expect(sql).toContain("ELSE c.name");
  });
});
