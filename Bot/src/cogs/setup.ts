import {
  ChannelType,
  Events,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  ThumbnailBuilder,
  type AnySelectMenuInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type ModalSubmitInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  LabelBuilder,
  ModalBuilder,
  ContainerBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { Pool } from "pg";
import { IS_LOCAL_BOT } from "../config";
import { isGuildManager } from "../domain/permissions";
import {
  getGuildConfig,
  mergeDisplayConfig,
  readDisplaySettings,
  upsertGuild,
  type GuildConfigWithDisplay,
} from "../guildRegistry";
import { button, card, colors, payload, row, text } from "../ui/components";
import { uiEmoji } from "../ui/emojis";

const MANAGE_ERROR = "この操作にはサーバー管理権限、またはBot管理者である必要があります。";

/** 設定ガイドのURL (説明欄とフッターに載せる) */
const GUIDE_URL = "https://github.com/y-exe/DiscordAnalytics/blob/main/docs/guide/setup.md";

// GuildText, GuildAnnouncement
const ANNOUNCE_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
// GuildText, GuildAnnouncement, GuildForum
const AGGREGATE_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
];
const CATEGORY_CHANNEL_TYPES = [ChannelType.GuildCategory];

/** selectの選択肢は25個まで */
const SELECT_MAX = 25;

/** customIdは `setup:{kind}:{action}[:ページ]` / モーダルは `setupm:{action}` (tokumei-botと同じコロン区切り)。
 * ページは初回セットアップウィザードの選択肢がどのページかを示す (省略時は通常画面に戻る) */
const cid = {
  view: (v: string, page?: number) => `setup:view:${v}${page === undefined ? "" : `:${page}`}`,
  sel: (s: string, page?: number) => `setup:sel:${s}${page === undefined ? "" : `:${page}`}`,
  mode: (m: string) => `setup:mode:${m}`,
  clear: (c: string) => `setup:clear:${c}`,
  dom: (d: string, page?: number) => `setup:dom:${d}${page === undefined ? "" : `:${page}`}`,
  done: () => "setup:done",
  modal: (m: string, page?: number) => `setupm:${m}${page === undefined ? "" : `:${page}`}`,
};

/** select・clear操作後に再描画するセクション */
const SECTION_OF: Record<string, string> = {
  announce: "announce",
  kingrole: "kingrole",
  excludeadd: "exclude",
  excluderemove: "exclude",
  privatecats: "private",
  privatecatsremove: "private",
  whitelistadd: "visibility",
  whitelistremove: "visibility",
  hiddenadd: "visibility",
  hiddenremove: "visibility",
  bottomcats: "bottomcats",
  bottomcatsremove: "bottomcats",
  managers: "managers",
};

const KNOWN_VIEWS = new Set([
  "main",
  "announce",
  "kingrole",
  "exclude",
  "private",
  "visibility",
  "bottomcats",
  "managers",
  "domains",
  "wizard",
  "cancel",
  "done",
]);
const KNOWN_SELECTS = new Set([
  ...Object.keys(SECTION_OF),
  "announce",
  "kingrole",
  "invitedom",
  "domainremove",
]);
const KNOWN_MODES = new Set(["all", "whitelist", "hidden"]);
const KNOWN_DOM = new Set(["guild", "invite", "custom", "label"]);

export function setupCommandDefinitions() {
  return [
    {
      name: "setup",
      description:
        "サーバーの設定 (発言王ロール・除外チャンネル・Webサイト表示・ドメインなど) を管理します",
    },
  ];
}

/** ComponentsV2メッセージの共通ペイロード (画面の再描画に使う) */
function v2(components: ContainerBuilder[]): {
  components: ContainerBuilder[];
  flags: number;
  allowedMentions: { parse: never[] };
} {
  return {
    components,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

function backRow(): ActionRowBuilder<ButtonBuilder> {
  return row(button(cid.view("main"), "戻る"));
}

/** 表示モードを判定する。保存済みモードを優先 (リストが空でもモード内で編集できるように)。
 * バックエンドの表示は別途リストの優先順位 (ホワイトリスト > 非表示) で決まる */
function visibilityMode(settings: {
  whitelistChannelIds: string[];
  hiddenChannelIds: string[];
  visibilityMode?: "all" | "whitelist" | "hidden";
}): {
  mode: "all" | "whitelist" | "hidden";
  label: string;
} {
  const stored = settings.visibilityMode;
  if (stored === "whitelist" || stored === "hidden") {
    const ids =
      stored === "whitelist" ? settings.whitelistChannelIds : settings.hiddenChannelIds;
    if (ids.length > 0) {
      return {
        mode: stored,
        label:
          stored === "whitelist"
            ? `ホワイトリスト ${ids.length}件`
            : `${ids.length}件を非表示`,
      };
    }
    return { mode: stored, label: "未設定 (現在はすべて表示)" };
  }
  if (settings.whitelistChannelIds.length > 0) {
    return { mode: "whitelist", label: `ホワイトリスト ${settings.whitelistChannelIds.length}件` };
  }
  if (settings.hiddenChannelIds.length > 0) {
    return { mode: "hidden", label: `${settings.hiddenChannelIds.length}件を非表示` };
  }
  return { mode: "all", label: "すべて表示" };
}

// ============================== 共通パーツ ==============================

/** 絵文字をボタンに付ける (アプリ絵文字 `<:name:id>` とユニコード両対応)。
 * 方針: 色付き (Primary/Success/Danger) のボタンには自作絵文字を付けない */
function emojiButton(
  id: string,
  label: string,
  emoji: string,
  style = ButtonStyle.Secondary,
): ButtonBuilder {
  const match = /^<a?:(\w+):(\d+)>$/.exec(emoji);
  const result = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  return match ? result.setEmoji({ id: match[2], name: match[1] }) : result.setEmoji({ name: emoji });
}

/** リスト表示。多すぎる場合は省略して注記する */
function bulletList(ids: string[], render: (id: string) => string, max = 15): string {
  if (ids.length === 0) return "なし";
  const lines = ids.slice(0, max).map((id) => `- ${render(id)}`);
  if (ids.length > max) lines.push(`-# ほか${ids.length - max}件`);
  return lines.join("\n");
}

/** 見出し+サムネイル付きのカードを組み立てる */
function headingCard(
  heading: string,
  iconUrl: string | null,
  accent = colors.info,
): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(accent);
  const display = text(heading);
  if (iconUrl) {
    container.addSectionComponents(
      new SectionBuilder().addTextDisplayComponents(display).setThumbnailAccessory(new ThumbnailBuilder().setURL(iconUrl)),
    );
  } else {
    container.addTextDisplayComponents(display);
  }
  return container;
}

// ============================== ビュー ==============================

/** メイン画面。現在の状態を1行ずつのリストで示し、ボタンで各設定へ飛ぶ */
export function mainView(
  guildName: string,
  config: GuildConfigWithDisplay,
  iconUrl: string | null = null,
  notice?: string,
): ContainerBuilder[] {
  const settings = readDisplaySettings(config);
  const visibility = visibilityMode(settings);
  const domains = config.domains;

  const container = headingCard(
    `## ${uiEmoji.info} サーバー設定
**${guildName}** のランキングとダッシュボード (${config.primaryDomains[0] ?? "Webサイト"}) を設定します。`,
    iconUrl,
  );
  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    text(
      [
        `- **${uiEmoji.count} ドメイン**: ${IS_LOCAL_BOT ? "ローカル環境では設定できません (本番Botで設定)" : domains.length > 0 ? `${domains.length}件 (${domains[0]})` : "未設定 (標準サブドメインは自動登録されます)"}`,
        `- **${uiEmoji.time} 告知先**: ${config.announceChannelId ? `<#${config.announceChannelId}>` : "未設定"}`,
        `- **${uiEmoji.warning} 集計除外チャンネル**: ${config.excludedChannelIds.length > 0 ? `${config.excludedChannelIds.length}件` : "なし"}`,
        `- **${uiEmoji.content} その他の集約**: ${settings.privateChatCategoryIds.length > 0 ? `「${settings.privateChatLabel}」${settings.privateChatCategoryIds.length}カテゴリ` : "未設定"}`,
        `- **${uiEmoji.check} Web表示**: ${visibility.label}`,
        `- **${uiEmoji.info} 下段固定**: ${settings.bottomChannelCategoryIds.length > 0 ? `${settings.bottomChannelCategoryIds.length}カテゴリ` : "未設定"}`,
        `- **${uiEmoji.reporter} 発言王ロール**: ${config.kingRoleId ? `<@&${config.kingRoleId}>` : "未設定"}`,
        `- **${uiEmoji.flag} 編集権限**: ${settings.setupManagerRoleIds.length > 0 ? `${settings.setupManagerRoleIds.length}ロール` : "サーバー管理権限のみ"}`,
      ].join("\n"),
    ),
  );
  container.addSeparatorComponents(new SeparatorBuilder());
  container.addActionRowComponents(
    row(
      emojiButton(cid.view("domains"), "ドメイン", uiEmoji.count),
      emojiButton(cid.view("announce"), "告知先", uiEmoji.time),
      emojiButton(cid.view("kingrole"), "発言王ロール", uiEmoji.reporter),
    ),
  );
  container.addActionRowComponents(
    row(
      emojiButton(cid.view("exclude"), "除外チャンネル", uiEmoji.warning),
      emojiButton(cid.view("private"), "その他の集約", uiEmoji.content),
      emojiButton(cid.view("visibility"), "Web表示", uiEmoji.check),
    ),
  );
  container.addActionRowComponents(
    row(
      emojiButton(cid.view("bottomcats"), "下段固定", uiEmoji.info),
      emojiButton(cid.view("managers"), "編集権限", uiEmoji.flag),
      new ButtonBuilder().setLabel("設定ガイド").setStyle(ButtonStyle.Link).setURL(GUIDE_URL),
    ),
  );
  if (notice) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(text(`### ${uiEmoji.check} 実行結果\n${notice}`));
  }
  container.addTextDisplayComponents(
    text("-# 変更はすぐに反映されます。この画面は実行者にのみ表示されます。"),
  );
  return [container];
}

/** 初回導入用ウィザード (tokumei-botのsetupViewと同じ「前へ/次へ進む」方式)。
 * ドメインを最初に確認し、ロール系は最後 (任意) に回す */
export function wizardView(
  config: GuildConfigWithDisplay,
  page: number,
  guildName: string,
  iconUrl: string | null,
  invites: string[] = [],
): ContainerBuilder[] {
  const settings = readDisplaySettings(config);
  const titles = ["ドメイン", "チャンネル設定", "確認して完了"];
  const progress = ["① ドメイン", "② チャンネル", "③ 確認"]
    .map((label, index) => (index === page ? `**${label}**` : label))
    .join("　›　");

  const menu = headingCard(
    `## ${uiEmoji.info} セットアップ\n**${guildName}** にDiscord Analyticsを導入します · **${page + 1}/3 ${titles[page]}**`,
    iconUrl,
  );
  menu.addTextDisplayComponents(text(progress));
  menu.addSeparatorComponents(new SeparatorBuilder());

  if (page === 0) {
    if (IS_LOCAL_BOT) {
      menu.addTextDisplayComponents(
        text(
          `### ${uiEmoji.warning} ドメイン設定\nローカル開発環境ではドメインを設定できません (URLは本番インフラのDNS・エッジに依存するため)。\n本番Botの /setup で設定してください。`,
        ),
      );
    } else {
    const lines = config.domains.map(
      (d) => `- \`https://${d}\`${config.primaryDomains.includes(d) ? " (代表)" : ""}`,
    );
    menu.addTextDisplayComponents(
      text(
        `### ${uiEmoji.count} ダッシュボードドメイン\nWebサイトのURLです。標準サブドメイン (\`[サーバーID].${SUBDOMAIN_BASE_DOMAIN}\`) はBot参加時に自動登録されるので、このままでも使えます。\n**現在 (${config.domains.length}件)**\n${lines.length > 0 ? lines.join("\n") : "なし"}`,
      ),
    );
    menu.addTextDisplayComponents(
      text(
        `### ${uiEmoji.check} ドメインを追加\n**独自ドメイン**: DNS管理画面でCNAMEを向けてから登録します (Cloudflare管理なら登録後にダッシュボードへのリンクを出します)。\n**招待コード**: このサーバーの招待コードから \`[コード].${SUBDOMAIN_BASE_DOMAIN}\` を作れます (一覧にないコードは「カスタム招待コード」から入力)。`,
      ),
    );
    menu.addActionRowComponents(
      row(button(cid.dom("custom", 0), "独自ドメインを登録", ButtonStyle.Success)),
    );
    menu.addActionRowComponents(inviteDomainSelect(invites, 0));
    if (config.domains.length > 0) {
      menu.addSeparatorComponents(new SeparatorBuilder());
      menu.addTextDisplayComponents(
        text(
          `**${uiEmoji.warning} ドメインを削除**\n選んだドメインの登録を削除します (そのURLにアクセスできなくなります)。標準サブドメインは削除できません。`,
        ),
      );
      menu.addActionRowComponents(domainRemoveSelect(config));
    }
    }
  } else if (page === 1) {
    menu.addTextDisplayComponents(
      text(
        `### ${uiEmoji.time} 告知先チャンネル\n毎月1日に前月の発言王とランキングを通知します。\n**現在**: ${config.announceChannelId ? `<#${config.announceChannelId}>` : "未設定"}`,
      ),
    );
    menu.addActionRowComponents(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(cid.sel("announce", 1))
          .setPlaceholder("告知先チャンネルを選択 (未選択でスキップ)")
          .setMinValues(0)
          .setMaxValues(1)
          .setChannelTypes(...ANNOUNCE_CHANNEL_TYPES),
      ),
    );
    menu.addSeparatorComponents(new SeparatorBuilder());
    menu.addTextDisplayComponents(
      text(
        `### ${uiEmoji.warning} 集計除外チャンネル\nランキング・統計に含めないチャンネルです。\n**現在 (${config.excludedChannelIds.length}件)**\n${bulletList(config.excludedChannelIds, (id) => `<#${id}>`)}`,
      ),
    );
    menu.addActionRowComponents(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(cid.sel("excludeadd", 1))
          .setPlaceholder("除外するチャンネルを選択")
          .setMinValues(0)
          .setMaxValues(SELECT_MAX)
          .setChannelTypes(...AGGREGATE_CHANNEL_TYPES),
      ),
    );
    menu.addSeparatorComponents(new SeparatorBuilder());
    menu.addTextDisplayComponents(
      text(
        `### ${uiEmoji.content} その他チャンネルの集約\n指定カテゴリ配下のチャンネルを、Webサイトでは「${settings.privateChatLabel}総合」の1つにまとめて表示します。\n**現在 (${settings.privateChatCategoryIds.length}件)**\n${bulletList(settings.privateChatCategoryIds, (id) => `<#${id}>`)}`,
      ),
    );
    menu.addActionRowComponents(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(cid.sel("privatecats", 1))
          .setPlaceholder("集約するカテゴリを選択")
          .setMinValues(0)
          .setMaxValues(SELECT_MAX)
          .setChannelTypes(...CATEGORY_CHANNEL_TYPES),
      ),
    );
  } else {
    menu.addTextDisplayComponents(
      text(
        `### ${uiEmoji.check} 導入内容\n**ドメイン**: ${config.domains.length > 0 ? `${config.domains.length}件 (${config.domains[0]})` : "標準サブドメイン"}\n**告知先**: ${config.announceChannelId ? `<#${config.announceChannelId}>` : "未設定"}\n**除外チャンネル**: ${config.excludedChannelIds.length > 0 ? `${config.excludedChannelIds.length}件` : "なし"}\n**その他の集約**: ${settings.privateChatCategoryIds.length > 0 ? `「${settings.privateChatLabel}」${settings.privateChatCategoryIds.length}カテゴリ` : "未設定"}`,
      ),
    );
    menu.addSeparatorComponents(new SeparatorBuilder());
    menu.addTextDisplayComponents(
      text(
        `### ${uiEmoji.reporter} 発言王ロール (あとでOK)\n毎月1位のメンバーに付与するロールです。未設定のままでも動作します。\n**現在**: ${config.kingRoleId ? `<@&${config.kingRoleId}>` : "未設定"}`,
      ),
    );
    menu.addActionRowComponents(
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(cid.sel("kingrole", 2))
          .setPlaceholder("発言王ロールを選択 (未選択でスキップ)")
          .setMinValues(0)
          .setMaxValues(1),
      ),
    );
    menu.addActionRowComponents(row(button(cid.done(), "この内容で完了", ButtonStyle.Success)));
  }

  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addTextDisplayComponents(
    text(
      page === 2
        ? "-# 選択はすぐに保存済みです。スキップする場合も「キャンセル」で導入を完了できます。"
        : "-# 選択はすぐに保存されます。「次へ進む」で先へ進みます。あとから /setup でいつでも変更できます。",
    ),
  );
  menu.addActionRowComponents(
    row(
      ...(page > 0 ? [button(cid.view("wizard", page - 1), "前へ")] : []),
      ...(page < 2 ? [button(cid.view("wizard", page + 1), "次へ進む", ButtonStyle.Primary)] : []),
      ...(page === 2 ? [button(cid.view("cancel"), "キャンセル", ButtonStyle.Danger)] : []),
    ),
  );
  return [menu];
}

export function announceView(config: GuildConfigWithDisplay): ContainerBuilder[] {
  const menu = headingCard(
    `## ${uiEmoji.time} 月間ランキングの告知先\n毎月1日に前月の発言王とランキングを通知するチャンネルです。\n**現在**: ${config.announceChannelId ? `<#${config.announceChannelId}>` : "未設定"}`,
    null,
  );
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addActionRowComponents(
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(cid.sel("announce"))
        .setPlaceholder("告知先チャンネルを選択")
        .setMinValues(1)
        .setMaxValues(1)
        .setChannelTypes(...ANNOUNCE_CHANNEL_TYPES),
    ),
  );
  if (config.announceChannelId) {
    menu.addActionRowComponents(
      row(
        button(cid.clear("announce"), "設定を解除", ButtonStyle.Danger),
        button(cid.view("main"), "戻る"),
      ),
    );
  } else {
    menu.addActionRowComponents(backRow());
  }
  return [menu];
}

export function kingRoleView(config: GuildConfigWithDisplay): ContainerBuilder[] {
  const menu = headingCard(
    `## ${uiEmoji.reporter} 月間発言王ロール\n毎月1位のメンバーに付与されるロールです。\n**現在**: ${config.kingRoleId ? `<@&${config.kingRoleId}>` : "未設定"}`,
    null,
  );
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addActionRowComponents(
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(cid.sel("kingrole"))
        .setPlaceholder("発言王ロールを選択")
        .setMinValues(1)
        .setMaxValues(1),
    ),
  );
  if (config.kingRoleId) {
    menu.addActionRowComponents(
      row(
        button(cid.clear("kingrole"), "設定を解除", ButtonStyle.Danger),
        button(cid.view("main"), "戻る"),
      ),
    );
  } else {
    menu.addActionRowComponents(backRow());
  }
  menu.addTextDisplayComponents(
    text("-# ロールはBotより下の位置に置く必要があります (Botが付け替えます)。"),
  );
  return [menu];
}

function channelRemoveSelect(
  action: string,
  placeholder: string,
  ids: string[],
  nameOf: (id: string) => string,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = ids
    .slice(0, SELECT_MAX)
    .map((id) =>
      new StringSelectMenuOptionBuilder().setLabel(nameOf(id).slice(0, 100)).setValue(id),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(cid.sel(action))
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(Math.min(SELECT_MAX, options.length))
      .addOptions(options),
  );
}

export function excludeView(
  config: GuildConfigWithDisplay,
  nameOf: (id: string) => string,
): ContainerBuilder[] {
  const current = config.excludedChannelIds;
  const menu = headingCard(
    `## ${uiEmoji.warning} 集計除外チャンネル\nここで指定したチャンネルの発言はランキング・統計に含まれません。\n**現在 (${current.length}件)**\n${bulletList(current, (id) => `<#${id}>`)}`,
    null,
  );
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addActionRowComponents(
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(cid.sel("excludeadd"))
        .setPlaceholder("除外に追加するチャンネルを選択")
        .setMinValues(1)
        .setMaxValues(SELECT_MAX)
        .setChannelTypes(...AGGREGATE_CHANNEL_TYPES),
    ),
  );
  if (current.length > 0) {
    menu.addActionRowComponents(
      channelRemoveSelect("excluderemove", "選択したチャンネルの除外を解除", current, nameOf),
    );
    menu.addActionRowComponents(
      row(
        button(cid.clear("exclude"), "すべて解除", ButtonStyle.Danger),
        button(cid.view("main"), "戻る"),
      ),
    );
  } else {
    menu.addActionRowComponents(backRow());
  }
  return [menu];
}

export function privateView(
  config: GuildConfigWithDisplay,
  nameOf: (id: string) => string,
): ContainerBuilder[] {
  const settings = readDisplaySettings(config);
  const cats = settings.privateChatCategoryIds;
  const menu = headingCard(
    `## ${uiEmoji.content} その他チャンネルの集約 (Webサイト)\n指定したカテゴリ配下のチャンネルを、Webサイトでは**「${settings.privateChatLabel}総合」**の1つにまとめて表示します。\n**集約カテゴリ (${cats.length}件)**\n${bulletList(cats, (id) => `<#${id}>`)}\n**表示名**: 「${settings.privateChatLabel}」`,
    null,
  );
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addActionRowComponents(
    row(button(cid.dom("label"), "表示名を変更", ButtonStyle.Primary)),
  );
  menu.addActionRowComponents(
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(cid.sel("privatecats"))
        .setPlaceholder("集約するカテゴリを追加")
        .setMinValues(1)
        .setMaxValues(SELECT_MAX)
        .setChannelTypes(...CATEGORY_CHANNEL_TYPES),
    ),
  );
  if (cats.length > 0) {
    menu.addActionRowComponents(
      channelRemoveSelect("privatecatsremove", "選択したカテゴリの集約を解除", cats, nameOf),
    );
    menu.addActionRowComponents(
      row(
        button(cid.clear("privatecats"), "集約をやめる", ButtonStyle.Danger),
        button(cid.view("main"), "戻る"),
      ),
    );
  } else {
    menu.addActionRowComponents(backRow());
  }
  menu.addTextDisplayComponents(
    text("-# 集約中のチャンネルはWebサイトのチャンネル一覧から消えます (発言数はそのまま合算されます)。"),
  );
  return [menu];
}

export function visibilityView(
  config: GuildConfigWithDisplay,
  nameOf: (id: string) => string,
): ContainerBuilder[] {
  const settings = readDisplaySettings(config);
  const { mode, label } = visibilityMode(settings);
  const menu = headingCard(
    `## ${uiEmoji.check} Webサイトの表示チャンネル\nダッシュボードのサイドバーや個別チャンネルページに載せるチャンネルを制御します。\n**現在**: ${label}`,
    null,
  );
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addActionRowComponents(
    row(
      button(
        cid.mode("all"),
        "すべて表示",
        mode === "all" ? ButtonStyle.Primary : ButtonStyle.Secondary,
      ),
      button(
        cid.mode("whitelist"),
        "ホワイトリスト",
        mode === "whitelist" ? ButtonStyle.Primary : ButtonStyle.Secondary,
      ),
      button(
        cid.mode("hidden"),
        "一部を隠す",
        mode === "hidden" ? ButtonStyle.Primary : ButtonStyle.Secondary,
      ),
    ),
  );

  if (mode === "all") {
    menu.addTextDisplayComponents(
      text(
        "-# すべてのチャンネルが表示されます。「ホワイトリスト」で選んだチャンネルだけを表示、「一部を隠す」で選んだチャンネルを隠せます。",
      ),
    );
    menu.addActionRowComponents(backRow());
    return [menu];
  }
  const ids = mode === "whitelist" ? settings.whitelistChannelIds : settings.hiddenChannelIds;
  const addSel = mode === "whitelist" ? cid.sel("whitelistadd") : cid.sel("hiddenadd");
  const removeSel = mode === "whitelist" ? cid.sel("whitelistremove") : cid.sel("hiddenremove");
  const addPlaceholder =
    mode === "whitelist" ? "ホワイトリストに追加するチャンネルを選択" : "隠すチャンネルを選択";
  const removePlaceholder =
    mode === "whitelist" ? "選択したチャンネルを表示対象に戻す" : "選択したチャンネルを表示する";

  menu.addTextDisplayComponents(
    text(`**${mode === "whitelist" ? "表示するチャンネル" : "隠すチャンネル"} (${ids.length}件)**\n${bulletList(ids, (id) => `<#${id}>`)}`),
  );
  menu.addActionRowComponents(
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(addSel)
        .setPlaceholder(addPlaceholder)
        .setMinValues(1)
        .setMaxValues(SELECT_MAX)
        .setChannelTypes(...AGGREGATE_CHANNEL_TYPES),
    ),
  );
  if (ids.length > 0) {
    menu.addActionRowComponents(channelRemoveSelect(removeSel, removePlaceholder, ids, nameOf));
    menu.addActionRowComponents(
      row(
        button(
          cid.clear(mode === "whitelist" ? "whitelist" : "hidden"),
          "すべて解除",
          ButtonStyle.Danger,
        ),
        button(cid.view("main"), "戻る"),
      ),
    );
  } else {
    menu.addActionRowComponents(backRow());
  }
  return [menu];
}

export function bottomcatsView(
  config: GuildConfigWithDisplay,
  nameOf: (id: string) => string,
): ContainerBuilder[] {
  const settings = readDisplaySettings(config);
  const cats = settings.bottomChannelCategoryIds;
  const menu = headingCard(
    `## ${uiEmoji.content} チャンネルの下段固定\n指定したカテゴリ配下のチャンネルを、Webサイトのサイドバーの下段に寄せて表示します。\n**固定カテゴリ (${cats.length}件)**\n${bulletList(cats, (id) => `<#${id}>`)}`,
    null,
  );
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addActionRowComponents(
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(cid.sel("bottomcats"))
        .setPlaceholder("下段に寄せるカテゴリを追加")
        .setMinValues(1)
        .setMaxValues(SELECT_MAX)
        .setChannelTypes(...CATEGORY_CHANNEL_TYPES),
    ),
  );
  if (cats.length > 0) {
    menu.addActionRowComponents(
      channelRemoveSelect("bottomcatsremove", "選択したカテゴリの固定を解除", cats, nameOf),
    );
    menu.addActionRowComponents(
      row(
        button(cid.clear("bottomcats"), "すべて解除", ButtonStyle.Danger),
        button(cid.view("main"), "戻る"),
      ),
    );
  } else {
    menu.addActionRowComponents(backRow());
  }
  return [menu];
}

export function managersView(config: GuildConfigWithDisplay): ContainerBuilder[] {
  const settings = readDisplaySettings(config);
  const roles = settings.setupManagerRoleIds;
  const menu = headingCard(
    `## ${uiEmoji.reporter} 設定の編集権限\nこの設定画面 (/setup) を操作できるロールを指定します。\n**現在**: ${roles.length > 0 ? roles.map((id) => `<@&${id}>`).join(" ") : "サーバー管理権限のみ"}`,
    null,
  );
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addActionRowComponents(
    new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(cid.sel("managers"))
        .setPlaceholder("設定を編集できるロールを選択")
        .setMinValues(0)
        .setMaxValues(SELECT_MAX),
    ),
  );
  if (roles.length > 0) {
    menu.addTextDisplayComponents(
      text(`**指定中のロール (${roles.length}件)**\n${bulletList(roles, (id) => `<@&${id}>`)}`),
    );
    menu.addActionRowComponents(
      row(
        button(cid.clear("managers"), "指定をやめる", ButtonStyle.Danger),
        button(cid.view("main"), "戻る"),
      ),
    );
  } else {
    menu.addActionRowComponents(backRow());
  }
  menu.addTextDisplayComponents(
    text("-# サーバー管理権限 (サーバー設定を変更できる人)・サーバー所有者・Bot管理者は常に編集できます。"),
  );
  return [menu];
}

export function domainsView(
  config: GuildConfigWithDisplay,
  notice?: string,
  invites: string[] = [],
): ContainerBuilder[] {
  if (IS_LOCAL_BOT) {
    // ローカルBotのDBに登録してもDNS・エッジ配信は変わらず、URLは機能しない
    return [
      card(
        "ドメイン設定はローカル環境ではできません",
        `ダッシュボードのURL (\`*.${SUBDOMAIN_BASE_DOMAIN}\` や独自ドメイン) は、本番インフラのDNS (ワイルドカード) とエッジの配信設定に依存します。ローカルBotのDBに登録してもURLは機能しません。\nドメインの設定・変更は**本番Botの /setup** で行ってください。`,
        colors.warning,
        uiEmoji.warning,
      ),
    ];
  }
  const lines = config.domains.map(
    (d) => `- \`https://${d}\`${config.primaryDomains.includes(d) ? " (代表)" : ""}`,
  );
  const menu = headingCard(
    `## ${uiEmoji.count} ダッシュボードドメイン\nWebサイトのURLとして使えるドメインです。標準サブドメイン (\`[サーバーID].${SUBDOMAIN_BASE_DOMAIN}\`) はBot参加時に自動登録されます。\n**登録済み (${config.domains.length}件)**\n${lines.length > 0 ? lines.join("\n") : "なし"}`,
    null,
  );
  // 実行結果は最大1つだけ表示する (連続した結果で読みにくくならないように)
  if (notice) {
    menu.addSeparatorComponents(new SeparatorBuilder());
    menu.addTextDisplayComponents(text(`### ${uiEmoji.check} 実行結果\n${notice}`));
  }
  menu.addSeparatorComponents(new SeparatorBuilder());
  menu.addTextDisplayComponents(
    text(
      `### ${uiEmoji.check} ドメインを追加\n**独自ドメイン**: DNS管理画面でCNAMEを向けてから登録します (Cloudflare管理なら登録後にダッシュボードへのリンクを出します)。\n**招待コード**: このサーバーの招待コードから \`[コード].${SUBDOMAIN_BASE_DOMAIN}\` を作れます。`,
    ),
  );
  menu.addActionRowComponents(
    row(button(cid.dom("custom"), "独自ドメインを登録", ButtonStyle.Success)),
  );
  menu.addActionRowComponents(inviteDomainSelect(invites));
  if (config.domains.length > 0) {
    menu.addSeparatorComponents(new SeparatorBuilder());
    menu.addTextDisplayComponents(
      text(
        `**${uiEmoji.warning} ドメインを削除**\n選んだドメインの登録を削除します (そのURLにアクセスできなくなります)。標準サブドメイン (\`[サーバーID].${SUBDOMAIN_BASE_DOMAIN}\`) は削除できません。`,
      ),
    );
    menu.addActionRowComponents(domainRemoveSelect(config));
  }
  menu.addActionRowComponents(backRow());
  return [menu];
}

/** 登録済みドメインを削除するプルダウン */
function domainRemoveSelect(
  config: GuildConfigWithDisplay,
): ActionRowBuilder<StringSelectMenuBuilder> {
  // 標準サブドメイン ([サーバーID].base) はCNAME先・バックリンクで必須のため削除不可
  const standard = buildSubdomain(config.guildId);
  const options = config.domains.slice(0, SELECT_MAX).map((domain) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(domain.slice(0, 100))
      .setValue(domain)
      .setDescription(
        domain === standard
          ? "標準サブドメイン (削除不可)"
          : config.primaryDomains.includes(domain)
            ? "代表ドメイン"
            : "登録を削除します",
      ),
  );
  return new ActionRowBuilder<StringSelectMenuBuilder>()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(cid.sel("domainremove"))
        .setPlaceholder("削除するドメインを選択")
        .setMinValues(1)
        .setMaxValues(Math.min(SELECT_MAX, options.length))
        .addOptions(options),
    );
}

/** 招待コードを選ぶプルダウン。先頭に「カスタム招待コード」を置く */
function inviteDomainSelect(
  invites: string[],
  page?: number,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = [
    new StringSelectMenuOptionBuilder()
      .setLabel("カスタム招待コード (手入力)")
      .setValue("custom")
      .setDescription("一覧にないコードを Discordの招待コードとして直接入力します"),
    ...invites.slice(0, SELECT_MAX - 1).map((code) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(code.slice(0, 100))
        .setValue(code)
        .setDescription(`このコードで [${code.slice(0, 40)}].${SUBDOMAIN_BASE_DOMAIN} を作成`),
    ),
  ];
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(cid.sel("invitedom", page))
      .setPlaceholder("招待コードを選択 (カスタムは先頭)")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options),
  );
}

// ============================== モーダル ==============================

function labelModal(current: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(cid.modal("label"))
    .setTitle("集約チャンネルの表示名");
  modal.addLabelComponents(
    new LabelBuilder().setLabel("Webサイトでの表示名 (例: プラチャ)").setTextInputComponent(
      new TextInputBuilder()
        .setCustomId("label")
        .setStyle(TextInputStyle.Short)
        .setMaxLength(30)
        .setRequired(false)
        .setValue(current === "その他" ? "" : current)
        .setPlaceholder("その他"),
    ),
  );
  return modal;
}

function inviteModal(page?: number): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(cid.modal("invite", page))
    .setTitle("招待コードでサブドメイン設定");
  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel("招待コード (このサーバー専用のURLになります)")
      .setDescription(
        `入力したコードで [コード].${SUBDOMAIN_BASE_DOMAIN} を作成します。例: discord.gg/abc123 → abc123.${SUBDOMAIN_BASE_DOMAIN}`,
      )
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId("code")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50)
          .setRequired(true)
          .setPlaceholder("discord.gg/ 以降のコード"),
      ),
  );
  return modal;
}

function customModal(page?: number): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(cid.modal("custom", page))
    .setTitle("独自ドメインを設定");
  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel("登録する独自ドメイン (例: dashboard.example.com)")
      .setDescription(
        `事前にDNSへ CNAME → [サーバーID].${SUBDOMAIN_BASE_DOMAIN} を向けてください。未反映でも登録はできます (後から再度登録して確認)。`,
      )
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId("domain")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(253)
          .setRequired(true)
          .setPlaceholder("dashboard.example.com"),
      ),
  );
  return modal;
}

// ============================== ドメイン処理 (旧サブコマンドから流用) ==============================

/** サブドメインのベースドメイン (既定: yexe.top) */
export const SUBDOMAIN_BASE_DOMAIN = (
  process.env.SUBDOMAIN_BASE_DOMAIN || "yexe.top"
).toLowerCase();

/** サブドメインラベルを検証する。招待コードはケースセンシティブなため小文字化は行わない */
export function normalizeSubdomainLabel(raw: string): string | null {
  const input = raw.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/.test(input)) return null;
  return input;
}

export function buildSubdomain(label: string): string {
  return `${label}.${SUBDOMAIN_BASE_DOMAIN}`;
}

/** 独自ドメインの形式検証。エラーメッセージまたはnull (OK) を返す */
export function validateCustomDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase();
  if (!domain) return "ドメインを指定してください。";
  if (domain.length > 253) return "ドメインが長すぎます。";
  if (domain === SUBDOMAIN_BASE_DOMAIN || domain.endsWith(`.${SUBDOMAIN_BASE_DOMAIN}`)) {
    return `${SUBDOMAIN_BASE_DOMAIN} のサブドメインは招待コードまたは標準サブドメインで設定してください。`;
  }
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
    return "ドメインの形式が正しくありません (例: example.com)。";
  }
  return null;
}

interface DomainRow {
  domain: string;
  guild_id: string | bigint;
  is_active: boolean;
}

async function upsertGuildDomain(
  pool: Pool,
  guildId: string,
  domain: string,
  source: "guild" | "invite" | "custom",
  inviteCode: string | null,
): Promise<string | null> {
  const { rows } = await pool.query(
    "SELECT guild_id, is_active FROM guild_domains WHERE domain = $1",
    [domain],
  );
  if (rows.length > 0) {
    const existing = rows[0] as DomainRow;
    if (String(existing.guild_id) !== guildId && existing.is_active) {
      return "そのドメインは既に他のサーバーが使用しています。";
    }
  }
  await pool.query(
    `
    INSERT INTO guild_domains (domain, guild_id, source, invite_code, is_active)
    VALUES ($1, $2, $3, $4, TRUE)
    ON CONFLICT (domain) DO UPDATE
    SET guild_id = EXCLUDED.guild_id,
        source = EXCLUDED.source,
        invite_code = EXCLUDED.invite_code,
        is_active = TRUE
    `,
    [domain, guildId, source, inviteCode],
  );
  return null;
}

/** 招待コードの归属ギルドを取得する。解決できない場合はエラーを返す。
 * transientは一時的なAPI失敗 (レート制限・ネットワーク断等) で確定情報が得られなかったことを示す */
async function fetchInviteGuildId(
  client: Client,
  code: string,
): Promise<{ guildId: string | null; error: string | null; transient: boolean }> {
  try {
    const invite = (await client.rest.get(`/invites/${encodeURIComponent(code)}`)) as {
      guild?: { id?: string } | null;
    };
    return { guildId: invite.guild?.id ?? null, error: null, transient: false };
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { status?: number }).status
        : undefined;
    if (status === 404) {
      return {
        guildId: null,
        error: "招待コードが見つかりません (失効している可能性があります)。",
        transient: false,
      };
    }
    console.error(`招待取得エラー (${code}): ${error}`);
    return {
      guildId: null,
      error: "招待コードの確認中にエラーが発生しました。",
      transient: true,
    };
  }
}

function subdomainResult(domain: string, labelKind: string): string {
  return [
    `ダッシュボードのサブドメインを **https://${domain}** に設定しました。`,
    "エッジが最初のアクセスで証明書を自動発行します。少し待ってからアクセスしてください。",
    labelKind === "サーバーID"
      ? "-# このサブドメインはサーバーID由来のため失効しません。"
      : "-# 元の招待コードが失効・変更されると、このドメインは自動的に無効化されます。",
  ].join("\n");
}

/** 招待コード由来のサブドメインを登録する (モーダルから)。エラー文または結果文を返す */
async function registerInviteSubdomain(
  client: Client,
  pool: Pool,
  guildId: string,
  code: string,
): Promise<string> {
  const label = normalizeSubdomainLabel(code);
  if (!label) {
    return "招待コードには半角英数字とハイフン・アンダースコアのみ使用できます (先頭と末尾は英数字)。";
  }
  // バニティコードは /invites API で解決できないため、現在のバニティと一致する場合は検証をスキップする
  let vanity: string | null = null;
  try {
    vanity = (await client.guilds.fetch(guildId).then((g) => g.fetchVanityData())).code;
  } catch {
    vanity = null;
  }
  if (vanity && vanity === label) {
    const domain = buildSubdomain(label);
    const conflict = await upsertGuildDomain(pool, guildId, domain, "invite", label);
    return conflict ?? subdomainResult(domain, "バニティ招待コード");
  }
  const invite = await fetchInviteGuildId(client, label);
  if (invite.error) return invite.error;
  if (invite.guildId && invite.guildId !== guildId) {
    return "その招待コードは他のサーバーのものです。自サーバーの招待コードを指定してください。";
  }
  const domain = buildSubdomain(label);
  const conflict = await upsertGuildDomain(pool, guildId, domain, "invite", label);
  return conflict ?? subdomainResult(domain, "招待コード");
}

/** ドメインのDNSゾーン名をNSレコードから特定する (見つからなければnull) */
async function detectZoneName(domain: string): Promise<string | null> {
  const dns = await import("node:dns/promises");
  const labels = domain.split(".");
  for (let index = 0; index < labels.length - 1; index++) {
    const candidate = labels.slice(index).join(".");
    if (!candidate.includes(".")) break;
    try {
      const ns = await dns.resolveNs(candidate);
      if (ns.length > 0) return candidate;
    } catch {
      /* NSレコードなし → 親ゾーンを試す */
    }
  }
  return null;
}

/** 独自ドメインを登録する (モーダルから)。エラー文または結果文を返す */
async function registerCustomDomain(pool: Pool, guildId: string, raw: string): Promise<string> {
  const error = validateCustomDomain(raw);
  if (error) return error;
  const domain = raw.trim().toLowerCase();
  const conflict = await upsertGuildDomain(pool, guildId, domain, "custom", null);
  if (conflict) return conflict;

  // 登録者自身のDNSにCNAMEを向けてもらう必要がある。
  // NSレコードからプロバイダを判定し、CloudflareならダッシュボードのDNS画面へのリンクを出す
  const target = `${guildId}.${SUBDOMAIN_BASE_DOMAIN}`;
  const zone = await detectZoneName(domain);
  let zoneNs: string[] = [];
  if (zone) {
    const dns = await import("node:dns/promises");
    zoneNs = await dns.resolveNs(zone).catch(() => []);
  }
  const recordGuide = `追加するレコード: **CNAME** · 名前 \`${domain}\` · 内容 \`${target}\``;
  const cloudflare = zone !== null && zoneNs.some((ns) => ns.toLowerCase().endsWith("ns.cloudflare.com"));
  if (cloudflare && zone) {
    return [
      `ダッシュボードのドメインを **https://${domain}** に登録しました。`,
      `**${domain}** はCloudflareで管理されています。下のリンクからDNSレコードを追加してください。`,
      `ゾーン: **${zone}**\n[CloudflareでDNSレコードを追加する](https://dash.cloudflare.com/?to=/:account/:zone/dns/records)`,
      recordGuide,
      "DNSの反映を待ってからアクセスしてください (通常は数分以内)。",
    ].join("\n");
  }
  return [
    `ダッシュボードのドメインを **https://${domain}** に登録しました。`,
    `DNS管理画面 (プロバイダのコンパネ) で、次のレコードを追加してください:`,
    recordGuide,
    `DNSの反映後、この画面から再度登録すると接続を確認できます。`,
  ].join("\n");
}

/**
 * 招待コード由来のサブドメインの失効をチェックする (6時間ごと)。
 * 招待が存在しない、または別ギルドの招待になっていたらドメインを無効化する。
 * ただしコードがそのギルドの現在のバニティURLと一致する場合は維持する。
 */
export async function checkInviteDomains(client: Client, pool: Pool): Promise<void> {
  const { rows } = await pool.query(
    `
    SELECT d.domain, d.invite_code, d.guild_id
    FROM guild_domains d
    WHERE d.source = 'invite' AND d.is_active AND d.invite_code IS NOT NULL
    `,
  );
  for (const row of rows as Array<{
    domain: string;
    invite_code: string;
    guild_id: string | bigint;
  }>) {
    const invite = await fetchInviteGuildId(client, row.invite_code);
    // 一時的なAPI失敗ではドメインを無効化しない (レート制限等で誤無効化するのを防ぐ)
    if (invite.transient) continue;
    const owned = invite.guildId === String(row.guild_id);
    if (owned) continue;
    // 招待が404のときだけバニティURLで復帰を試みる (バニティは /invites APIで解決できない)
    if (invite.error !== null) {
      try {
        const guild = client.guilds.cache.get(String(row.guild_id));
        const vanity = guild ? (await guild.fetchVanityData()).code : null;
        if (vanity && vanity === row.invite_code) continue;
      } catch {
        /* バニティ未設定 → 失効扱い */
      }
    }
    await pool.query("UPDATE guild_domains SET is_active = FALSE WHERE domain = $1", [row.domain]);
    console.warn(`サブドメイン無効化: ${row.domain} (${invite.error ?? "招待が別ギルドに移管"})`);
  }
}

// ============================== 設定の適用 ==============================

async function setAnnounceChannel(
  pool: Pool,
  guildId: string,
  channelId: string | null,
): Promise<void> {
  await pool.query(
    "UPDATE guilds SET announce_channel_id = $2, updated_at = CURRENT_TIMESTAMP WHERE guild_id = $1",
    [guildId, channelId],
  );
}

async function setKingRole(pool: Pool, guildId: string, roleId: string | null): Promise<void> {
  await pool.query(
    "UPDATE guilds SET king_role_id = $2, updated_at = CURRENT_TIMESTAMP WHERE guild_id = $1",
    [guildId, roleId],
  );
}

async function setExcludedChannels(pool: Pool, guildId: string, ids: string[]): Promise<void> {
  await pool.query(
    "UPDATE guilds SET excluded_channel_ids = $2::bigint[], updated_at = CURRENT_TIMESTAMP WHERE guild_id = $1",
    [guildId, [...new Set(ids)]],
  );
}

/** selectの適用。actionごとにDBを更新する */
async function applySelect(
  pool: Pool,
  guildId: string,
  action: string,
  values: string[],
): Promise<void> {
  const config = await getGuildConfig(pool, guildId);
  if (!config) throw new Error("ギルド設定が見つかりません。先に /setup を実行してください。");
  const settings = readDisplaySettings(config);

  switch (action) {
    case "announce":
      // 未選択 (minValues=0) で送ると解除になる
      await setAnnounceChannel(pool, guildId, values[0] ?? null);
      return;
    case "kingrole":
      await setKingRole(pool, guildId, values[0] ?? null);
      return;
    case "excludeadd":
      await setExcludedChannels(pool, guildId, [...config.excludedChannelIds, ...values]);
      return;
    case "excluderemove":
      await setExcludedChannels(
        pool,
        guildId,
        config.excludedChannelIds.filter((id) => !values.includes(id)),
      );
      return;
    case "privatecats":
      await mergeDisplayConfig(pool, guildId, {
        privateChatCategoryIds: [...new Set([...settings.privateChatCategoryIds, ...values])],
      });
      return;
    case "privatecatsremove":
      await mergeDisplayConfig(pool, guildId, {
        privateChatCategoryIds: settings.privateChatCategoryIds.filter(
          (id) => !values.includes(id),
        ),
      });
      return;
    case "whitelistadd":
      await mergeDisplayConfig(pool, guildId, {
        whitelistChannelIds: [...new Set([...settings.whitelistChannelIds, ...values])],
      });
      return;
    case "whitelistremove":
      await mergeDisplayConfig(pool, guildId, {
        whitelistChannelIds: settings.whitelistChannelIds.filter((id) => !values.includes(id)),
      });
      return;
    case "hiddenadd":
      await mergeDisplayConfig(pool, guildId, {
        hiddenChannelIds: [...new Set([...settings.hiddenChannelIds, ...values])],
      });
      return;
    case "hiddenremove":
      await mergeDisplayConfig(pool, guildId, {
        hiddenChannelIds: settings.hiddenChannelIds.filter((id) => !values.includes(id)),
      });
      return;
    case "bottomcats":
      await mergeDisplayConfig(pool, guildId, {
        bottomChannelCategoryIds: [...new Set([...settings.bottomChannelCategoryIds, ...values])],
      });
      return;
    case "bottomcatsremove":
      await mergeDisplayConfig(pool, guildId, {
        bottomChannelCategoryIds: settings.bottomChannelCategoryIds.filter(
          (id) => !values.includes(id),
        ),
      });
      return;
    case "managers":
      await mergeDisplayConfig(pool, guildId, {
        setupManagerRoleIds: [...new Set([...settings.setupManagerRoleIds, ...values])],
      });
      return;
    default:
      throw new Error(`不明な操作: ${action}`);
  }
}

async function applyClear(pool: Pool, guildId: string, action: string): Promise<void> {
  switch (action) {
    case "announce":
      await setAnnounceChannel(pool, guildId, null);
      return;
    case "kingrole":
      await setKingRole(pool, guildId, null);
      return;
    case "exclude":
      await setExcludedChannels(pool, guildId, []);
      return;
    case "privatecats":
      await mergeDisplayConfig(pool, guildId, { privateChatCategoryIds: [] });
      return;
    case "whitelist":
      await mergeDisplayConfig(pool, guildId, { whitelistChannelIds: [] });
      return;
    case "hidden":
      await mergeDisplayConfig(pool, guildId, { hiddenChannelIds: [] });
      return;
    case "bottomcats":
      await mergeDisplayConfig(pool, guildId, { bottomChannelCategoryIds: [] });
      return;
    case "managers":
      await mergeDisplayConfig(pool, guildId, { setupManagerRoleIds: [] });
      return;
    default:
      throw new Error(`不明な操作: ${action}`);
  }
}

async function applyMode(pool: Pool, guildId: string, mode: string): Promise<void> {
  if (mode === "all") {
    await mergeDisplayConfig(pool, guildId, {
      visibilityMode: "all",
      whitelistChannelIds: [],
      hiddenChannelIds: [],
    });
    return;
  }
  if (mode === "whitelist") {
    // ホワイトリストが優先されるため、そちら側のリストは必ず空にしておく
    await mergeDisplayConfig(pool, guildId, { visibilityMode: "whitelist", hiddenChannelIds: [] });
    return;
  }
  if (mode === "hidden") {
    await mergeDisplayConfig(pool, guildId, { visibilityMode: "hidden", whitelistChannelIds: [] });
    return;
  }
  throw new Error(`不明なモード: ${mode}`);
}

// ============================== 描画 ==============================

/** サーバーの招待コード一覧を取得する (バニティURLを先頭に)。取得できない場合は空 */
async function fetchInviteCodes(guild: Guild | null): Promise<string[]> {
  if (!guild) return [];
  const codes: string[] = [];
  try {
    const vanity = await guild.fetchVanityData().then((v) => v.code).catch(() => null);
    if (vanity) codes.push(vanity);
    const invites = await guild.invites.fetch();
    for (const invite of invites.values()) {
      if (invite.code && !codes.includes(invite.code)) codes.push(invite.code);
    }
  } catch {
    /* 招待一覧を取得できないサーバーでは手入力のみ */
  }
  return codes;
}

type RenderContext = {
  pool: Pool;
  guildId: string;
  guildName: string;
  /** メイン画面・ウィザードのサムネイル用ギルドアイコン */
  iconUrl: string | null;
  /** サーバーの招待コード一覧 (ドメインのプルダウンに使う) */
  invites: string[];
  /** セレクトの選択肢名用 (ギルドキャッシュからチャンネル名を引く) */
  nameOf: (id: string) => string;
};

async function renderView(
  ctx: RenderContext,
  view: string,
  notice?: string,
  page?: number,
): Promise<ContainerBuilder[]> {
  const config = await getGuildConfig(ctx.pool, ctx.guildId);
  if (!config) {
    return [
      card(
        "設定がありません",
        "ギルド情報の登録を待っています。少し待ってから再度開いてください。",
        colors.warning,
      ),
    ];
  }
  switch (view) {
    case "announce":
      return announceView(config);
    case "kingrole":
      return kingRoleView(config);
    case "exclude":
      return excludeView(config, ctx.nameOf);
    case "private":
      return privateView(config, ctx.nameOf);
    case "visibility":
      return visibilityView(config, ctx.nameOf);
    case "bottomcats":
      return bottomcatsView(config, ctx.nameOf);
    case "managers":
      return managersView(config);
    case "domains":
      return domainsView(config, notice, ctx.invites);
    case "wizard":
      return wizardView(config, page ?? 0, ctx.guildName, ctx.iconUrl, ctx.invites);
    case "cancel":
    case "done":
      // 完了フラグを立てて通常画面へ (スキップでキャンセルした場合も完了扱い)
      await mergeDisplayConfig(ctx.pool, ctx.guildId, { setupDone: true });
      return mainView(
        ctx.guildName,
        config,
        ctx.iconUrl,
        view === "done" ? "セットアップが完了しました！ いつでも /setup から変更できます。" : undefined,
      );
    default: {
      const settings = readDisplaySettings(config);
      // 何も設定されていない初回はウィザードから始める
      const fresh =
        !config.kingRoleId &&
        !config.announceChannelId &&
        config.excludedChannelIds.length === 0 &&
        !settings.setupDone;
      if (fresh) return wizardView(config, page ?? 0, ctx.guildName, ctx.iconUrl, ctx.invites);
      return mainView(ctx.guildName, config, ctx.iconUrl, notice);
    }
  }
}

// ============================== ロード ==============================

export function loadSetup(client: Client, pool: Pool): void {
  // サブドメイン失効チェック (6時間ごと)
  client.once(Events.ClientReady, () => {
    void checkInviteDomains(client, pool).catch((error) =>
      console.error(`失効チェックエラー: ${error}`),
    );
    setInterval(
      () =>
        void checkInviteDomains(client, pool).catch((error) =>
          console.error(`失効チェックエラー: ${error}`),
        ),
      6 * 60 * 60 * 1000,
    );
  });

  type SetupInteraction =
    | ChatInputCommandInteraction
    | ButtonInteraction
    | AnySelectMenuInteraction
    | ModalSubmitInteraction;

  const ctxOf = async (interaction: SetupInteraction): Promise<RenderContext> => ({
    pool,
    guildId: interaction.guildId ?? "",
    guildName: interaction.guild?.name ?? "このサーバー",
    iconUrl: interaction.guild?.iconURL() ?? null,
    invites: await fetchInviteCodes(interaction.guild),
    nameOf: (id: string) => interaction.guild?.channels.cache.get(id)?.name ?? id,
  });

  const renderOrUpdate = async (
    interaction: ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction,
    view: string,
    notice?: string,
    page?: number,
  ): Promise<void> => {
    const components = await renderView(await ctxOf(interaction), view, notice, page);
    if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
      await interaction.reply(v2(components));
    } else {
      await interaction.update(v2(components));
    }
  };

  /** 編集権限: サーバー管理系権限 + 設定で許可されたロール */
  const canManageSetup = async (interaction: SetupInteraction): Promise<boolean> => {
    if (isGuildManager(interaction)) return true;
    if (!interaction.inGuild() || !interaction.guildId) return false;
    const config = await getGuildConfig(pool, interaction.guildId);
    if (!config) return false;
    const roles = readDisplaySettings(config).setupManagerRoleIds;
    if (roles.length === 0) return false;
    const memberRoles = (interaction.member as { roles?: { cache?: Map<string, unknown> } } | null)
      ?.roles?.cache;
    if (!memberRoles) return false;
    return roles.some((roleId) => memberRoles.has(roleId));
  };

  const reportError = async (interaction: SetupInteraction, error: unknown): Promise<void> => {
    const origin =
      "customId" in interaction
        ? interaction.customId
        : "commandName" in interaction
          ? interaction.commandName
          : "unknown";
    console.error(`Setup Error [${origin}]: ${error}`);
    if (!interaction.isRepliable()) return;
    const payloadData = payload(
      [
        card(
          "エラー",
          "設定の更新中にエラーが発生しました。時間をおいて再度お試しください。",
          colors.danger,
          uiEmoji.error,
        ),
      ],
      true,
    );
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payloadData).catch(() => {});
    } else {
      await interaction.reply(payloadData).catch(() => {});
    }
  };

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === "setup") {
        if (!interaction.inGuild() || !interaction.guildId) {
          await interaction.reply({
            content: "サーバー内で実行してください。",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (!(await canManageSetup(interaction))) {
          await interaction.reply({ content: MANAGE_ERROR, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (interaction.guild) await upsertGuild(pool, interaction.guild);
        await interaction.editReply(v2(await renderView(await ctxOf(interaction), "main")));
        return;
      }

      if (interaction.isButton() || interaction.isAnySelectMenu()) {
        if (!interaction.customId.startsWith("setup:")) return;
        if (!interaction.inGuild() || !interaction.guildId) {
          await interaction.reply({
            content: "サーバー内で実行してください。",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (!(await canManageSetup(interaction))) {
          await interaction.reply({ content: MANAGE_ERROR, flags: MessageFlags.Ephemeral });
          return;
        }
        const [, kind, action, pageArg] = interaction.customId.split(":");
        if (!action) return;
        const page =
          pageArg !== undefined && /^\d+$/.test(pageArg) && Number(pageArg) < 3
            ? Number(pageArg)
            : undefined;

        // 旧バージョンの画面に残ったコンポーネントはunknownになりえる。
        // クラッシュさせず、/setupの開き直しを促す
        const staleNotice =
          "この操作は古い画面のものです。/setup をもう一度実行して最新の画面を開いてください。";
        if (kind === "view") {
          if (!KNOWN_VIEWS.has(action)) {
            console.warn(`未知の操作 (${interaction.customId})`);
            await renderOrUpdate(interaction, "main", staleNotice);
            return;
          }
          await renderOrUpdate(interaction, action, undefined, page);
          return;
        }
        if (kind === "sel" && interaction.isAnySelectMenu()) {
          if (!KNOWN_SELECTS.has(action)) {
            console.warn(`未知の操作 (${interaction.customId})`);
            await renderOrUpdate(interaction, "main", staleNotice);
            return;
          }
          // 登録済みドメインの削除 (標準サブドメインはCNAME先で必須のため削除不可)
          if (action === "domainremove") {
            const requested = [...interaction.values];
            if (requested.length === 0) return;
            const standard = buildSubdomain(interaction.guildId);
            const domains = requested.filter((domain) => domain !== standard);
            if (domains.length === 0) {
              await renderOrUpdate(
                interaction,
                "domains",
                `**https://${standard}** は標準サブドメインのため削除できません (独自ドメインのCNAME先・Botのリンク等で必須です)。`,
              );
              return;
            }
            await pool.query(
              "DELETE FROM guild_domains WHERE guild_id = $1 AND domain = ANY($2::text[]) AND source <> 'guild'",
              [interaction.guildId, domains],
            );
            const skipped = requested.length - domains.length > 0;
            const removedNotice =
              domains.length === 1
                ? `**https://${domains[0]}** の登録を削除しました。`
                : `${domains.length}件のドメイン登録を削除しました。`;
            const notice = skipped
              ? `${removedNotice}\n標準サブドメイン (${standard}) は削除できません。`
              : removedNotice;
            await renderOrUpdate(interaction, "domains", notice);
            return;
          }
          // 招待コードドメイン: カスタム入力はモーダル、それ以外はコードから即登録
          if (action === "invitedom") {
            const code = interaction.values[0];
            if (code === "custom") {
              await interaction.showModal(inviteModal(page));
              return;
            }
            const label = normalizeSubdomainLabel(code);
            if (!label) {
              await renderOrUpdate(
                interaction,
                page !== undefined ? "wizard" : "domains",
                "そのコードはサブドメインに使えません (半角英数字とハイフン・アンダースコアのみ)。\n別の招待コードを選ぶか、「カスタム招待コード」から入力してください。",
                page,
              );
              return;
            }
            const domain = buildSubdomain(label);
            const conflict = await upsertGuildDomain(
              pool,
              interaction.guildId,
              domain,
              "invite",
              label,
            );
            const notice = conflict ?? subdomainResult(domain, "招待コード");
            await renderOrUpdate(
              interaction,
              page !== undefined ? "wizard" : "domains",
              notice,
              page,
            );
            return;
          }
          await applySelect(pool, interaction.guildId, action, [...interaction.values]);
          // ページ付きの選択肢はウィザードのもの → 同じページへ戻す
          await renderOrUpdate(
            interaction,
            page !== undefined ? "wizard" : (SECTION_OF[action] ?? "main"),
            undefined,
            page,
          );
          return;
        }
        if (kind === "mode") {
          if (!KNOWN_MODES.has(action)) {
            console.warn(`未知の操作 (${interaction.customId})`);
            await renderOrUpdate(interaction, "main", staleNotice);
            return;
          }
          await applyMode(pool, interaction.guildId, action);
          await renderOrUpdate(interaction, "visibility");
          return;
        }
        if (kind === "clear") {
          if (!SECTION_OF[action] && !KNOWN_SELECTS.has(action)) {
            console.warn(`未知の操作 (${interaction.customId})`);
            await renderOrUpdate(interaction, "main", staleNotice);
            return;
          }
          await applyClear(pool, interaction.guildId, action);
          await renderOrUpdate(interaction, SECTION_OF[action] ?? "main");
          return;
        }
        // ローカルBotではドメイン操作を受け付けない (本番DB・DNS・エッジに依存するため)
        if (IS_LOCAL_BOT && (kind === "dom" || action === "invitedom" || action === "domainremove")) {
          console.warn(`ローカルBotでドメイン操作が送られました (${interaction.customId})`);
          await renderOrUpdate(interaction, "domains");
          return;
        }
        if (kind === "dom") {
          if (!KNOWN_DOM.has(action)) {
            console.warn(`未知の操作 (${interaction.customId})`);
            await renderOrUpdate(interaction, "main", staleNotice);
            return;
          }
          if (action === "guild") {
            const domain = buildSubdomain(interaction.guildId);
            const conflict = await upsertGuildDomain(
              pool,
              interaction.guildId,
              domain,
              "guild",
              null,
            );
            const notice = conflict ?? subdomainResult(domain, "サーバーID");
            await renderOrUpdate(
              interaction,
              page !== undefined ? "wizard" : "domains",
              notice,
              page,
            );
            return;
          }
          if (action === "label") {
            const config = await getGuildConfig(pool, interaction.guildId);
            const current = config ? readDisplaySettings(config).privateChatLabel : "その他";
            await interaction.showModal(labelModal(current));
            return;
          }
          if (action === "invite") {
            await interaction.showModal(inviteModal(page));
            return;
          }
          if (action === "custom") {
            await interaction.showModal(customModal(page));
            return;
          }
        }
        return;
      }

      if (interaction.isModalSubmit()) {
        if (!interaction.customId.startsWith("setupm:")) return;
        if (!interaction.inGuild() || !interaction.guildId) {
          await interaction.reply({
            content: "サーバー内で実行してください。",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (!(await canManageSetup(interaction))) {
          await interaction.reply({ content: MANAGE_ERROR, flags: MessageFlags.Ephemeral });
          return;
        }
        const [, action, modalPageArg] = interaction.customId.split(":");
        const modalPage =
          modalPageArg !== undefined && /^\d+$/.test(modalPageArg) ? Number(modalPageArg) : undefined;
        if (action === "label") {
          const raw = interaction.fields.getTextInputValue("label").trim();
          await mergeDisplayConfig(pool, interaction.guildId, {
            privateChatLabel: raw || "その他",
          });
          await renderOrUpdate(interaction, "private");
          return;
        }
        if (action === "invite") {
          const code = interaction.fields.getTextInputValue("code");
          const notice = await registerInviteSubdomain(client, pool, interaction.guildId, code);
          await renderOrUpdate(
            interaction,
            modalPage !== undefined ? "wizard" : "domains",
            notice,
            modalPage,
          );
          return;
        }
        if (action === "custom") {
          const domain = interaction.fields.getTextInputValue("domain");
          const notice = await registerCustomDomain(pool, interaction.guildId, domain);
          await renderOrUpdate(
            interaction,
            modalPage !== undefined ? "wizard" : "domains",
            notice,
            modalPage,
          );
          return;
        }
      }
    } catch (error) {
      await reportError(interaction as SetupInteraction, error);
    }
  });
}
