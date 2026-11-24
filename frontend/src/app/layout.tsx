import type { Metadata, Viewport } from "next";
import ThemeProvider from "@/components/ThemeProvider";
import {
  DEFAULT_SITE_ORIGIN,
  getGuildBaseUrl,
  getGuildContext,
  sizedIconPng,
} from "@/lib/guild-context";
import { serializeJsonLd } from "@/lib/seo";
import "../styles/global.css";

const DEFAULT_DESCRIPTION =
  "Discordサーバーの活動量、ランキング、統計情報を可視化するダッシュボード。";

export async function generateMetadata(): Promise<Metadata> {
  const [guild, baseUrl] = await Promise.all([getGuildContext(), getGuildBaseUrl()]);
  const metadataBase = new URL(baseUrl ?? DEFAULT_SITE_ORIGIN);
  const subject = guild.name || "Discord Analytics";
  return {
    metadataBase,
    title: { default: `${subject} ダッシュボード`, template: `%s | ${subject} ダッシュボード` },
    description: `${subject}のDiscord活動量、ランキング、統計情報を可視化するダッシュボード。`,
    keywords: [subject, "Discord統計", "Discordランキング", "ダッシュボード"],
    applicationName: `${subject} ダッシュボード`,
    alternates: { canonical: "/" },
    openGraph: {
      type: "website",
      locale: "ja_JP",
      siteName: `${subject} ダッシュボード`,
      images: [
        { url: "/ranking.webp", width: 1200, height: 630, alt: `${subject} ダッシュボード` },
      ],
    },
    twitter: { card: "summary_large_image", images: ["/ranking.webp"] },
  };
}

// OSテーマに応じたステータスバー/フレーム色。ダークはglobal.cssの--background (0 0% 3.9%) と一致させる
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const guild = await getGuildContext();
  // ファビコンはギルドアイコン。未設定なら同梱の既定アイコンにフォールバック
  const favicon = sizedIconPng(guild.iconUrl, 128);
  const appleIcon = sizedIconPng(guild.iconUrl, 180);
  const baseUrl = (await getGuildBaseUrl()) ?? DEFAULT_SITE_ORIGIN;
  const siteName = guild.name ? `${guild.name} ダッシュボード` : "Discord Analytics";

  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        {favicon ? (
          <>
            <link rel="icon" href={favicon} />
            <link rel="apple-touch-icon" href={appleIcon ?? favicon} />
          </>
        ) : (
          <>
            <link rel="icon" href="/favicon.ico" sizes="any" />
            <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
          </>
        )}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Google+Sans:ital,opsz,wght@0,17..18,400..700;1,17..18,400..700&family=Dela+Gothic+One&family=JetBrains+Mono:wght@400;700;900&family=Noto+Sans+JP:wght@400;700;900&family=Outfit:wght@400;700;800&display=swap"
          rel="stylesheet"
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: serializeJsonLd({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: siteName,
              description: `${siteName} - Discordサーバーの活動量、ランキング、統計情報を可視化するダッシュボード。`,
              url: baseUrl,
              inLanguage: "ja",
            }),
          }}
        />
      </head>
      <body className="bg-background text-foreground font-sans min-h-screen">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
