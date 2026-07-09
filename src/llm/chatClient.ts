import { requestUrl } from "obsidian";
import { withTimeout } from "../util/withTimeout";
import type { CobrainSettings } from "../settings";
import { SseLineBuffer, extractStreamDelta } from "./sse";

// 空闲超时：非流式=整段等待上限；流式=两次增量之间的最大间隔（长回答总时长不设限，不该被总超时掐断）。
const CHAT_TIMEOUT_MS = 90_000;

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCallOpts {
  temperature?: number;
  maxTokens?: number;
  // 真取消：fetch 路径会中止底层请求（省 token）；requestUrl 兜底路径无法中止，取消只对 UI 生效。
  signal?: AbortSignal;
  // 提供即走流式（SSE），每收到一段增量文本回调一次。端点不支持流式时自动降级，最终仍整段返回。
  onDelta?: (text: string) => void;
}

// 端点已应答但状态码非 200。区别于网络层 TypeError：这类错误换传输方式（requestUrl）重试也没用。
export class HttpError extends Error {
  constructor(public status: number, bodyText: string) {
    super(`聊天 API ${status}：${bodyText.slice(0, 200)}`);
  }
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

// OpenAI 兼容的聊天客户端。持有 settings 引用、每次调用读最新 baseUrl/key/model，
// 这样在设置页改了端点或模型立即生效，无需重载插件。
//
// 传输选择：fetch 优先（可流式、AbortSignal 可真正中止请求），失败时按错误类型分流——
// - 网络层失败（TypeError，典型是端点不带 CORS 头）且尚未吐出任何增量 → 回退 Obsidian requestUrl（免 CORS，但不可中止、不流式）；
// - HTTP 4xx/5xx → 端点已应答，直接抛错不回退（换传输重试同样会失败，只多打一次接口）；
// - 已收到增量后中途断流 → 抛错不回退（回退重跑会让 onDelta 消费方拿到重复内容）。
export class ChatClient {
  constructor(
    private settings: CobrainSettings,
    // 测试注入口；运行时包一层 lambda 避免 fetch 脱离 globalThis 调用报 Illegal invocation
    private fetchImpl: typeof fetch | null = typeof fetch === "function" ? (...args) => fetch(...args) : null,
  ) {}

  async chat(messages: ChatMsg[], opts: ChatCallOpts = {}): Promise<string> {
    if (this.fetchImpl) {
      let deltaSeen = false;
      const onDelta = opts.onDelta
        ? (t: string) => { deltaSeen = true; opts.onDelta!(t); }
        : undefined;
      try {
        return await this.chatViaFetch(messages, opts, onDelta);
      } catch (e) {
        if (opts.signal?.aborted) throw e; // 用户主动停止：不回退
        if (e instanceof HttpError) throw e; // 端点已应答的业务错误：回退无意义
        if (deltaSeen) throw e; // 中途断流：回退会重复内容
        if (!(e instanceof TypeError)) throw e; // 解析/空内容等非网络层错误：换传输也无解
        console.warn("Cobrain: fetch 请求失败（多为端点无 CORS 头），回退 requestUrl 非流式", e);
      }
    }
    return this.chatViaRequestUrl(messages, opts);
  }

  private url(): string {
    return `${this.settings.llmBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  private requestInit(messages: ChatMsg[], opts: ChatCallOpts, stream: boolean): { headers: Record<string, string>; body: string } {
    return {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.settings.llmKey}` },
      body: JSON.stringify({
        model: this.settings.llmModel,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 2048,
        ...(stream ? { stream: true } : {}),
      }),
    };
  }

  private async chatViaFetch(messages: ChatMsg[], opts: ChatCallOpts, onDelta?: (t: string) => void): Promise<string> {
    try {
      return await this.fetchOnce(messages, opts, !!onDelta, onDelta);
    } catch (e) {
      // 个别代理不认 stream 参数直接 4xx：降一次非流式再试；仍失败则把该错误抛给上层。
      if (onDelta && e instanceof HttpError && !opts.signal?.aborted) {
        return await this.fetchOnce(messages, opts, false, undefined);
      }
      throw e;
    }
  }

  private async fetchOnce(messages: ChatMsg[], opts: ChatCallOpts, stream: boolean, onDelta?: (t: string) => void): Promise<string> {
    // 内部 controller 组合外部 signal + 空闲超时：任一触发即中止底层请求。
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort();
    if (opts.signal?.aborted) ctrl.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimedOut = false;
    // 每收到一个数据块重置：连接/首包/相邻增量任何一段超过 CHAT_TIMEOUT_MS 判为断流
    const armIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleTimedOut = true; ctrl.abort(); }, CHAT_TIMEOUT_MS);
    };
    try {
      armIdle();
      const res = await this.fetchImpl!(this.url(), {
        method: "POST",
        ...this.requestInit(messages, opts, stream),
        signal: ctrl.signal,
      });
      if (res.status !== 200) {
        const text = await res.text().catch(() => "");
        throw new HttpError(res.status, text);
      }
      const contentType = res.headers.get("content-type") ?? "";
      // 要了流式但端点静默忽略 stream 参数（返回普通 JSON）：按非流式整段解析
      if (!stream || !contentType.includes("text/event-stream") || !res.body) {
        armIdle();
        return parseChatResponse(await res.json());
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const buf = new SseLineBuffer();
      let acc = "";
      const consume = (payloads: string[]) => {
        for (const payload of payloads) {
          if (payload === "[DONE]") continue;
          let piece = "";
          try { piece = extractStreamDelta(JSON.parse(payload)); } catch { /* 心跳/非 JSON 行忽略 */ }
          if (piece) { acc += piece; onDelta?.(piece); }
        }
      };
      for (;;) {
        armIdle();
        const { done, value } = await reader.read();
        if (done) break;
        consume(buf.feed(decoder.decode(value, { stream: true })));
      }
      consume(buf.feed(decoder.decode()));
      consume(buf.flush());
      if (!acc.trim()) throw new Error("聊天 API 返回空内容");
      return acc;
    } catch (e) {
      if (idleTimedOut) throw new Error(`聊天 API超时（约 ${Math.round(CHAT_TIMEOUT_MS / 1000)} 秒无响应）`);
      throw e;
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  // requestUrl 兜底：免 CORS，但不可中止、不流式（超时只解锁调用方，底层请求仍会跑完，见 withTimeout 注释）。
  private async chatViaRequestUrl(messages: ChatMsg[], opts: ChatCallOpts): Promise<string> {
    const init = this.requestInit(messages, opts, false);
    const res = await withTimeout(
      requestUrl({ url: this.url(), method: "POST", ...init, throw: false }),
      CHAT_TIMEOUT_MS,
      "聊天 API",
    );
    if (res.status !== 200) {
      throw new Error(`聊天 API ${res.status}：${(res.text || "").slice(0, 200)}`);
    }
    return parseChatResponse(res.json);
  }
}
