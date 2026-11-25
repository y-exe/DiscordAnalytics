"use client";

import type { ReactNode } from "react";

/**
 * AI応答用の軽量Markdownレンダラ。
 * 対応: コードブロック (fenced)、見出し、リスト、太字、インラインコード、リンク。
 */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  // **太字**、`code`、[text](url) を順に処理する
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-bold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      const label = token.slice(1, token.indexOf("]"));
      const href = token.slice(token.indexOf("(") + 1, -1);
      nodes.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-accent-data underline underline-offset-2"
        >
          {label}
        </a>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderBlock(lines: string[], keyPrefix: string): ReactNode {
  const first = lines[0];
  if (/^#{1,4}\s/.test(first)) {
    const level = first.match(/^#+/)?.[0].length ?? 1;
    const text = first.replace(/^#+\s*/, "");
    const className =
      level <= 2
        ? "mt-4 mb-2 text-lg font-black text-foreground"
        : "mt-3 mb-1.5 text-base font-bold text-foreground";
    return (
      <p key={keyPrefix} className={className}>
        {renderInline(text, keyPrefix)}
      </p>
    );
  }
  if (/^[-*]\s/.test(first)) {
    const items = lines.filter((line) => /^[-*]\s/.test(line));
    return (
      <ul key={keyPrefix} className="my-1.5 list-disc space-y-1 pl-5">
        {items.map((item, i) => (
          <li key={i} className="text-sm leading-relaxed">
            {renderInline(item.replace(/^[-*]\s*/, ""), `${keyPrefix}-${i}`)}
          </li>
        ))}
      </ul>
    );
  }
  if (/^\d+\.\s/.test(first)) {
    const items = lines.filter((line) => /^\d+\.\s/.test(line));
    return (
      <ol key={keyPrefix} className="my-1.5 list-decimal space-y-1 pl-5">
        {items.map((item, i) => (
          <li key={i} className="text-sm leading-relaxed">
            {renderInline(item.replace(/^\d+\.\s*/, ""), `${keyPrefix}-${i}`)}
          </li>
        ))}
      </ol>
    );
  }
  return (
    <p key={keyPrefix} className="my-1.5 text-sm leading-relaxed">
      {renderInline(lines.join("\n"), keyPrefix)}
    </p>
  );
}

export default function AiMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  // コードブロックで分割
  const parts = text.split(/```/);
  parts.forEach((part, partIndex) => {
    if (partIndex % 2 === 1) {
      // コードブロック: 1行目は言語指定 (あれば無視してそのまま表示しない)
      const body = part.replace(/^[a-zA-Z0-9_+-]*\n/, "");
      const code = body.replace(/\n$/, "");
      blocks.push(
        <pre
          key={`code-${partIndex}`}
          className="my-2 overflow-x-auto rounded-xl bg-muted px-4 py-3 font-mono text-xs leading-relaxed text-foreground"
        >
          <code>{code}</code>
        </pre>,
      );
      return;
    }
    // 通常テキスト: 空行区切りでブロック化
    const lines = part.split("\n");
    let group: string[] = [];
    let groupIsList: "ul" | "ol" | null = null;
    const flush = () => {
      if (group.length === 0) return;
      const isList = group.every((line) =>
        groupIsList === "ol" ? /^\d+\.\s/.test(line) : /^[-*]\s/.test(line),
      );
      blocks.push(
        isList
          ? renderBlock(group, `b-${partIndex}-${blocks.length}`)
          : renderBlock(
              group.filter((line) => line.trim() !== ""),
              `b-${partIndex}-${blocks.length}`,
            ),
      );
      group = [];
      groupIsList = null;
    };
    for (const line of lines) {
      if (line.trim() === "") {
        flush();
        continue;
      }
      const kind = /^\d+\.\s/.test(line) ? "ol" : /^[-*]\s/.test(line) ? "ul" : null;
      if (kind && groupIsList && kind !== groupIsList) flush();
      if (kind) groupIsList = kind;
      group.push(line);
    }
    flush();
  });
  return <div className="min-w-0">{blocks}</div>;
}
