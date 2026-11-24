import type { MetadataRoute } from "next";
import { getGuildContext, sizedIconPng } from "@/lib/guild-context";

export const dynamic = "force-dynamic";

// PWA用マニフェスト。Service Workerは導入しない (統計は常に最新を表示すべきで、
// オフラインキャッシュが鮮度を損なうため)。名前・アイコンはギルドごとに動的に出す。
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const guild = await getGuildContext();
  const name = guild.name ? `${guild.name} ダッシュボード` : "Discord Web Analytics";
  const icon = sizedIconPng(guild.iconUrl, 144);

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
    icons: icon
      ? [{ src: icon, sizes: "144x144", type: "image/png", purpose: "any" }]
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
