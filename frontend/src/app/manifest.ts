import type { MetadataRoute } from "next";
import { getGuildContext } from "@/lib/guild-context";

export const dynamic = "force-dynamic";

// PWA用マニフェスト。Service Workerは導入しない (統計は常に最新を表示すべきで、
// オフラインキャッシュが鮮度を損なうため)。名前・アイコンはギルドごとに動的に出す。
// アイコンは /guild-icon プロキシ経由で同一オリジンから配信する
// (CDN直リンクはPWAインストール・オフラインで壊れうるため)。
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const guild = await getGuildContext();
  const name = guild.name ? `${guild.name} ダッシュボード` : "Discord Web Analytics";

  return {
    id: "/",
    name,
    short_name: guild.name || "Analytics",
    description: `${name} - Discordサーバーの活動量、ランキング、統計情報を可視化するダッシュボード。`,
    lang: "ja",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: guild.iconUrl
      ? [
          { src: "/guild-icon?s=256", sizes: "256x256", type: "image/png", purpose: "any" },
          { src: "/guild-icon?s=512", sizes: "512x512", type: "image/png", purpose: "any" },
        ]
      : [
          {
            src: "/apple-touch-icon.png",
            sizes: "144x144",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/favicon.ico",
            sizes: "any",
            type: "image/x-icon",
          },
        ],
  };
}
