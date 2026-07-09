// OpenAI 兼容流式（SSE）解析。抽成纯逻辑：不碰网络，只处理文本 → data 载荷 → 增量内容，
// 这样跨 chunk 断行、[DONE]、非 JSON 心跳行这些边界都能直接单测。

// 行缓冲：feed() 吃任意切割的原始文本块，按行切出 `data:` 载荷；半行留在缓冲等下一块。
// 只认 data: 行（OpenAI 兼容实现的事件都走 data），event:/注释/空行全部忽略，\r\n 与 \n 都兼容。
export class SseLineBuffer {
  private buf = "";

  feed(text: string): string[] {
    this.buf += text;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? ""; // 最后一段可能是半行，留缓冲
    const payloads: string[] = [];
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.startsWith("data:")) continue;
      payloads.push(line.slice(5).trimStart());
    }
    return payloads;
  }

  // 流结束时调用：个别实现最后一行不带换行，缓冲里可能还压着一个完整 data 载荷。
  flush(): string[] {
    const rest = this.buf;
    this.buf = "";
    if (!rest) return [];
    const line = rest.endsWith("\r") ? rest.slice(0, -1) : rest;
    return line.startsWith("data:") ? [line.slice(5).trimStart()] : [];
  }
}

// 从单个流式 chunk 的 JSON 里取增量文本：choices[0].delta.content。
// usage 尾包没有 choices、reasoning 模型的 delta 可能只有 reasoning_content——都返回空串，调用方跳过。
export function extractStreamDelta(json: unknown): string {
  if (!json || typeof json !== "object" || !("choices" in json)) return "";
  const choices = (json as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const delta = (choices[0] as Record<string, unknown>).delta;
  if (!delta || typeof delta !== "object" || !("content" in delta)) return "";
  const content = (delta as Record<string, unknown>).content;
  return typeof content === "string" ? content : "";
}
