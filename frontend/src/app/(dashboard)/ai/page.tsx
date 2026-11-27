import type { Metadata } from "next";
import AIChatView from "@/components/views/AIChatView";
import { getGuildBaseUrl, getGuildContext } from "@/lib/guild-context";

export async function generateMetadata(): Promise<Metadata> {
  const baseUrl = await getGuildBaseUrl();
  return {
    title: "AI",
    description: "サーバーのデータについてAIエージェントに質問できます。",
    ...(baseUrl ? { alternates: { canonical: `${baseUrl}/ai` } } : {}),
  };
}

export default async function AIPage() {
  const guild = await getGuildContext();
  return (
    <AIChatView guildId={guild.guildId} guildIcon={guild.iconUrl ? `/guild-icon?s=128` : null} />
  );
}
