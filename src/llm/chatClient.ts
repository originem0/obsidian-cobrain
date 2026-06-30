import { requestUrl } from "obsidian";
import { withTimeout } from "../util/withTimeout";
import type { CobrainSettings } from "../settings";

// 文本对话超时 90s（requestUrl 不可中止，超时仅解锁 UI，见 withTimeout 注释）
const CHAT_TIMEOUT_MS = 90_000;

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

// 解析 OpenAI 兼容 /chat/completions 响应，取 choices[0].message.content。
// 抽成纯函数便于单测；缺字段抛「格式异常」，内容为空(如推理模型把预算耗在 reasoning 上、content 空)抛「空内容」。
export function parseChatResponse(json: unknown): string {
  const content =
    json && typeof json === "object" && "choices" in json && Array.isArray(json.choices) && json.choices[0]
      && typeof json.choices[0] === "object" && "message" in json.choices[0]
      && json.choices[0].message && typeof json.choices[0].message === "object" && "content" in json.choices[0].message
      ? json.choices[0].message.content : undefined;
  if (typeof content !== "string") throw new Error("聊天 API 返回格式异常");
  if (!content.trim()) throw new Error("聊天 API 返回空内容");
  return content;
}

// OpenAI 兼容的聊天客户端（非流式）。持有 settings 引用、每次调用读最新 baseUrl/key/model，
// 这样在设置页改了端点或模型立即生效，无需重载插件。用 Obsidian requestUrl 免 CORS、异步不占主线程。
export class ChatClient {
  constructor(private settings: CobrainSettings) {}

  async chat(messages: ChatMsg[], opts?: { temperature?: number; maxTokens?: number }): Promise<string> {
    const url = `${this.settings.llmBaseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await withTimeout(
      requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.settings.llmKey}` },
        body: JSON.stringify({
          model: this.settings.llmModel,
          messages,
          temperature: opts?.temperature ?? 0.7,
          max_tokens: opts?.maxTokens ?? 2048,
        }),
        throw: false,
      }),
      CHAT_TIMEOUT_MS,
      "聊天 API",
    );
    if (res.status !== 200) {
      throw new Error(`聊天 API ${res.status}：${(res.text || "").slice(0, 200)}`);
    }
    return parseChatResponse(res.json);
  }
}
