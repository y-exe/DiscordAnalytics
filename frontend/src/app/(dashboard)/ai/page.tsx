import type { Metadata } from "next";
import AIChatView from "@/components/views/AIChatView";
import { getGuildBaseUrl } from "@/lib/guild-context";

export async function generateMetadata(): Promise<Metadata> {
  const baseUrl = await getGuildBaseUrl();
  return {
    title: "AI",
    description: "サーバーのデータについてAIエージェントに質問できます。",
    ...(baseUrl ? { alternates: { canonical: `${baseUrl}/ai` } } : {}),
  };
}

export default function AIPage() {
  return <AIChatView />;
}
