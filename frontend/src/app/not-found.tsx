import type { Metadata } from "next";
import AppShell from "@/components/shell/AppShell";
import StatusPage from "@/components/shell/StatusPage";
import { getGuildContext, rootDomainOf } from "@/lib/guild-context";

export const metadata: Metadata = {
  title: "404 | ページが見つかりません",
  robots: { index: false, follow: false },
};

/** 全ルート共通の404ページ (サイドバー/フッター付き) */
export default async function NotFound() {
  const guild = await getGuildContext();
  return (
    <AppShell
      guild={{ name: guild.name, iconUrl: guild.iconUrl, isDefault: guild.isDefault }}
      siteDomain={rootDomainOf(guild.domain)}
    >
      <StatusPage
        code={404}
        title="Not Found"
        inline
        actions={[{ label: "ホームに戻る", href: "/" }]}
      />
    </AppShell>
  );
}
