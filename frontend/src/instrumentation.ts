/**
 * Next.jsサーバー起動時のフック (同一オリジン運用のみ)。
 * バックエンドのウォームループを起動し、公開済み月の累計キャッシュを温めておく。
 */
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PUBLIC_SAME_ORIGIN !== "true") return;
  // Pod起動直後はDBへの接続が一時的に失敗することがあるため、数回リトライする
  for (const delayMs of RETRY_DELAYS_MS) {
    try {
      const { getBackendRuntime } = await import("../../backend/src/runtime");
      const runtime = await getBackendRuntime();
      runtime.startWarmLoop();
      return;
    } catch (error) {
      console.error(`backend warm loop failed to start (retry in ${delayMs}ms):`, error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
