import type { Metadata } from "next";
import StatusPage from "@/components/shell/StatusPage";

export const metadata: Metadata = {
  title: "エラー",
  robots: { index: false, follow: false },
};

const TITLES: Record<string, string> = {
  "400": "Bad Request",
  "401": "Unauthorized",
  "403": "Forbidden",
  "404": "Not Found",
  "500": "Internal Server Error",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
  "504": "Gateway Timeout",
};

/** サーバー負荷系のステータス (500番台) は負荷のお知らせを出す */
function overloadMessage(code: string): string | undefined {
  const n = Number(code);
  if (Number.isInteger(n) && n >= 500 && n < 600) {
    return "現在サーバーに負荷がかかってるようです...!!\n後でもう一度お越しくださいませ (´・ω・`)";
  }
  return undefined;
}

/** チップに表示するパス。相対パスのみ許可する */
function safePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return /^\/[A-Za-z0-9\-._~!$&()*+,;=:@/?%]*$/.test(path) ? path : undefined;
}

/** API/ゲートウェイの障害時にリダイレクトされるエラーページ (/error?code=&msg=&path=) */
export default async function ErrorStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; msg?: string; path?: string }>;
}) {
  const { code, msg, path } = await searchParams;
  const safeCode = code && /^\d{3}$/.test(code) ? code : "500";
  const title = TITLES[safeCode] ?? (msg || "Error");
  // サーバー発のエラーID (error_id) を表示する。ユーザーがこれを報告すれば
  // 運用側はサーバーログを同じIDで引ける。表示は英数字と記号の一部に限定。
  const errorId =
    msg && typeof msg === "string" ? (msg.match(/error_id:\s*([0-9a-f]{8})/) ?? [])[1] : undefined;
  return (
    <StatusPage
      code={safeCode}
      title={title}
      message={overloadMessage(safeCode)}
      extra={
        errorId ? (
          <p className="font-mono text-xs text-muted-foreground">
            エラーID: <span className="select-all">{errorId}</span>
          </p>
        ) : undefined
      }
      chipPath={safePath(path) ?? "/error"}
      actions={[{ label: "ホームに戻る", href: "/" }]}
    />
  );
}
