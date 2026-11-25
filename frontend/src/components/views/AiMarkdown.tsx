"use client";

import { useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, Download } from "lucide-react";
import { ServerTagChip, UserAvatar } from "@/components/views/discord/DiscordIdentity";

/** メンションチップ用のユーザー情報 (/ai/mentions の応答) */
export interface AiMentionUser {
  user_id: string;
  display_name: string;
  username: string;
  avatar: string | null;
  avatar_fallback: string | null;
  avatar_decoration: string | null;
  primary_guild_tag: string | null;
  primary_guild_badge: string | null;
}

const MENTION_RE = /<@(\d{1,20})>/g;

/** AI出力のDiscordメンション <@id> をメンバーページへのリンクに変換する */
function preprocessMentions(text: string): string {
  const replaced = text.replace(
    MENTION_RE,
    (_match, id: string) => `[mention:${id}](/members/${id})`,
  );
  // ストリーミング途中の未完メンション (<@123...) は生の文字列を出さないよう隠す
  return replaced.replace(/<@\d{0,20}$/, "");
}

/** 拡張子の推定 (ダウンロード用) */
const EXT_MAP: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  jsx: "jsx",
  tsx: "tsx",
  python: "py",
  html: "html",
  xml: "xml",
  css: "css",
  json: "json",
  markdown: "md",
  bash: "sh",
  shell: "sh",
  sql: "sql",
  yaml: "yml",
  go: "go",
  rust: "rs",
  java: "java",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  php: "php",
  ruby: "rb",
  lua: "lua",
  swift: "swift",
  kotlin: "kt",
  dockerfile: "dockerfile",
  makefile: "mk",
  ini: "ini",
  toml: "toml",
  diff: "diff",
  plaintext: "txt",
};

/** コードブロック: 白背景+シンタックスハイライト+コピー/ダウンロード */
function CodeBlock({ lang, children }: { lang: string; children: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const text = () => preRef.current?.innerText ?? "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // コピー失敗は無視
    }
  };

  const download = () => {
    const ext = EXT_MAP[lang.toLowerCase()] ?? (lang ? lang.toLowerCase() : "txt");
    const blob = new Blob([text()], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = lang ? `code.${ext}` : "code.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-muted-foreground/20 bg-background">
      <div className="flex items-center justify-between border-b border-muted-foreground/15 bg-muted/60 px-4 py-1.5">
        <span className="font-mono text-[11px] font-bold text-muted-foreground">
          {lang || "code"}
        </span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="コードをコピー"
            title="コピー"
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={download}
            aria-label="コードをダウンロード"
            title="ダウンロード"
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      <pre
        ref={preRef}
        className="hljs overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed"
      >
        {children}
      </pre>
    </div>
  );
}

/** メンションチップ: アバター + 表示名 + サーバータグ。クリックでメンバーページへ */
function MentionChip({ id, users }: { id: string; users?: Record<string, AiMentionUser> }) {
  const user = users?.[id];
  return (
    <a
      href={`/members/${id}`}
      className="!no-underline mx-0.5 inline-flex items-center gap-1.5 rounded-full bg-muted/70 py-0.5 pr-1.5 pl-1 align-middle transition-colors hover:bg-muted"
      title={user ? `@${user.username}` : `ユーザーID: ${id}`}
    >
      <UserAvatar
        user={{
          user_id: id,
          avatar: user?.avatar ?? null,
          avatar_fallback: user?.avatar_fallback ?? null,
          avatar_decoration: user?.avatar_decoration ?? null,
        }}
        size={18}
      />
      <span className="text-xs leading-none font-bold text-foreground">
        {user?.display_name ?? `@${id}`}
      </span>
      <ServerTagChip
        tag={user?.primary_guild_tag ?? null}
        badge={user?.primary_guild_badge ?? null}
      />
    </a>
  );
}

/** コードブロックの言語名をpre直下のcode要素から取り出す */
function preLanguage(node: {
  children?: Array<{ tagName?: string; properties?: { className?: unknown } }>;
}): string {
  const code = node.children?.find((child) => child.tagName === "code");
  const classNames = code?.properties?.className;
  if (!Array.isArray(classNames)) return "";
  for (const cls of classNames) {
    if (typeof cls === "string" && cls.startsWith("language-")) return cls.slice(9);
  }
  return "";
}

/** AI応答用Markdownレンダラ (GFM + メンション + コードハイライト) */
export default function AiMarkdown({
  text,
  mentions,
}: {
  text: string;
  mentions?: Record<string, AiMentionUser>;
}) {
  const mentionLink = (href: string | undefined): string | null => {
    const match = typeof href === "string" ? /^\/members\/(\d{1,20})$/.exec(href) : null;
    return match ? match[1] : null;
  };

  return (
    <div className="min-w-0 [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-2 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_p]:my-1.5 [&_p]:text-sm [&_p]:leading-relaxed [&_strong]:font-bold [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_li]:text-sm [&_li]:leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          h1: (props) => <h2 className="mt-4 mb-2 text-lg font-black text-foreground" {...props} />,
          h2: (props) => <h2 className="mt-4 mb-2 text-lg font-black text-foreground" {...props} />,
          h3: (props) => (
            <h3 className="mt-3 mb-1.5 text-base font-bold text-foreground" {...props} />
          ),
          h4: (props) => (
            <h4 className="mt-3 mb-1.5 text-base font-bold text-foreground" {...props} />
          ),
          code: ({ className, children, ...rest }) => {
            // ブロックコードはpreで処理するため、ここではインラインコードのみ
            if (typeof className === "string" && className.includes("language-")) {
              return (
                <code className="hljs font-mono" {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
                {...rest}
              >
                {children}
              </code>
            );
          },
          pre: ({ node, children }) => (
            <CodeBlock lang={preLanguage(node as never)}>{children}</CodeBlock>
          ),
          a: ({ href, children }) => {
            const id = mentionLink(href);
            if (id) return <MentionChip id={id} users={mentions} />;
            return (
              <a
                href={href}
                className="font-bold underline underline-offset-2"
                {...{ target: "_blank", rel: "noopener noreferrer" }}
              >
                {children}
              </a>
            );
          },
          table: (props) => (
            <div className="my-3 overflow-x-auto rounded-xl border border-muted-foreground/20 bg-background">
              <table className="w-full border-collapse text-sm" {...props} />
            </div>
          ),
          thead: (props) => <thead className="bg-foreground" {...props} />,
          th: (props) => (
            <th
              className="border-b border-muted-foreground/20 px-3 py-2 text-left font-bold whitespace-nowrap text-background"
              {...props}
            />
          ),
          td: (props) => <td className="px-3 py-2 align-top" {...props} />,
          tr: (props) => (
            <tr
              className="border-b border-muted-foreground/10 transition-colors last:border-b-0 hover:bg-muted/40"
              {...props}
            />
          ),
        }}
      >
        {preprocessMentions(text)}
      </ReactMarkdown>
    </div>
  );
}
