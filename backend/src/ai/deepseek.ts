/**
 * DeepSeek (OpenAI互換) ストリーミングchat completionクライアント。
 * ツール呼び出し (tool_calls) に対応し、ツール実行は呼び出し側に委譲する。
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface StreamCallbacks {
  /** 追加テキストのチャンク */
  onDelta: (text: string) => void;
  /** ツール呼び出しを検知した時点 (引数の蓄積完了前) */
  onToolCalls?: (calls: ToolCall[]) => void;
  /** ツールを実行して結果 (output: AIに渡すテキスト, summary: UI表示ラベル) を返す */
  onToolExecute?: (call: ToolCall) => Promise<{ output: string; summary: string } | undefined>;
}

const MAX_TOOL_ROUNDS = 12;
const REQUEST_TIMEOUT_MS = 180_000;

type DeepSeekStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
      finish_reason?: string | null;
    };
    finish_reason?: string | null;
  }>;
};

/**
 * チャット補完を1回実行する。ツール呼び出しがあれば実行して再度呼び、
 * 最終的なテキスト回答を返す (ツールループ内)。
 */
export async function runChat(
  config: { apiKey: string; model: string; baseUrl: string },
  messages: ChatMessage[],
  tools: ToolDefinition[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<{ content: string; toolRuns: Array<{ name: string; summary: string }> }> {
  const chatMessages = [...messages];
  const toolRuns: Array<{ name: string; summary: string }> = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const isLastRound = round === MAX_TOOL_ROUNDS;
    const result = await streamOnce(
      config,
      chatMessages,
      isLastRound ? [] : tools,
      callbacks,
      signal,
    );

    if (!result.toolCalls || result.toolCalls.length === 0) {
      return { content: result.content, toolRuns };
    }

    chatMessages.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls,
    });
    if (result.content) callbacks.onDelta("\n");

    for (const call of result.toolCalls) {
      const executed = await callbacks.onToolExecute?.(call);
      const output = executed?.output ?? `Error: tool "${call.function.name}" is unavailable.`;
      if (executed) toolRuns.push({ name: call.function.name, summary: executed.summary });
      chatMessages.push({
        role: "tool",
        content: output.slice(0, 24_000),
        tool_call_id: call.id,
      });
    }
  }
  // ループ上限に達した場合の保険 (到達しない)
  return { content: "", toolRuns };
}

/** 1回分のstreaming chat completion。ツール呼び出しを検知したら完了まで蓄積して返す */
async function streamOnce(
  config: { apiKey: string; model: string; baseUrl: string },
  messages: ChatMessage[],
  tools: ToolDefinition[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] | null }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(onAbort, REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`DeepSeek API error ${res.status}: ${text.slice(0, 300)}`);
    }

    let content = "";
    const toolAccumulators = new Map<number, ToolCall>();
    let sawToolCalls = false;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk: DeepSeekStreamChunk;
        try {
          chunk = JSON.parse(data) as DeepSeekStreamChunk;
        } catch {
          continue;
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          callbacks.onDelta(delta.content);
        }
        if (delta.tool_calls) {
          sawToolCalls = true;
          for (const partial of delta.tool_calls) {
            const existing = toolAccumulators.get(partial.index) ?? {
              id: "",
              type: "function" as const,
              function: { name: "", arguments: "" },
            };
            if (partial.id) existing.id = partial.id;
            if (partial.function?.name) existing.function.name += partial.function.name;
            if (partial.function?.arguments)
              existing.function.arguments += partial.function.arguments;
            toolAccumulators.set(partial.index, existing);
          }
        }
      }
    }

    const toolCalls =
      sawToolCalls && toolAccumulators.size > 0
        ? [...toolAccumulators.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
        : null;
    if (toolCalls) callbacks.onToolCalls?.(toolCalls);
    return { content, toolCalls };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
