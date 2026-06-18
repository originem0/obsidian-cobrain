import { requestUrl } from "obsidian";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

// OpenAI 兼容的聊天客户端（非流式）。用 Obsidian requestUrl 免 CORS、异步不占主线程。
export class ChatClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
  ) {}

  async chat(messages: ChatMsg[], opts?: { temperature?: number; maxTokens?: number }): Promise<string> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts?.temperature ?? 0.7,
        max_tokens: opts?.maxTokens ?? 2048,
      }),
      throw: false,
    });
    if (res.status !== 200) {
      throw new Error(`聊天 API ${res.status}：${(res.text || "").slice(0, 200)}`);
    }
    const content = res.json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("聊天 API 返回格式异常");
    return content;
  }
}
