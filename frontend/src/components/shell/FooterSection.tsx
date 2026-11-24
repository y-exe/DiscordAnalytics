"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { SiGithub } from "react-icons/si";

type FooterLink = { text: string; href: string };

const menuLinks: FooterLink[] = [
  { text: "ホーム", href: "/" },
  { text: "全期間ランキング", href: "/?m=all" },
];

const policyLinks: FooterLink[] = [
  { text: "プライバシー", href: "/privacy" },
  { text: "規約", href: "/terms" },
];

function FooterLinkList({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <section>
      <h2 className="mb-4 text-sm font-black text-foreground">{title}</h2>
      <ul className="space-y-3 text-sm font-bold text-muted-foreground">
        {links.map((link) => (
          <li key={link.text}>
            <Link href={link.href} className="transition-colors hover:text-foreground">
              {link.text}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** ダッシュボードのフッター。
 * ブランディングは設定ドメインから導出したルートドメインのみで、固有のクレジットは持たない。
 * action にはページ単位のユーティリティ (カードの順列リセット等) を渡せる */
export default function FooterSection({
  domain,
  action,
}: {
  /** 表示に使うルートドメイン (例: ymkw.top)。未解決なら省略 */
  domain?: string | null;
  action?: ReactNode;
}) {
  return (
    <footer className="border-t border-sidebar-border bg-sidebar px-6 py-12 md:px-10 md:py-14">
      <div className="mx-auto grid max-w-6xl gap-10">
        <div className="grid grid-cols-2 gap-8">
          <FooterLinkList title="メニュー" links={menuLinks} />
          <FooterLinkList title="サイトポリシー" links={policyLinks} />
        </div>

        <div className="flex items-center justify-between gap-6">
          {domain ? (
            <div className="min-w-0">
              <p className="truncate font-['Outfit',Arial,sans-serif] text-3xl font-bold tracking-tighter text-foreground">
                {domain}
              </p>
              <p className="mt-1 text-sm font-bold text-muted-foreground">
                Copyright © 2026 {domain}
              </p>
            </div>
          ) : (
            <span aria-hidden />
          )}
          <a
            href="https://github.com/y-exe/DiscordAnalytics"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHubリポジトリを開く"
            className="flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          >
            <SiGithub className="h-5 w-5" aria-hidden="true" />
          </a>
        </div>
      </div>
    </footer>
  );
}
