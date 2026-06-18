export interface Chunk { text: string; heading: string; }

// 策略：按 ATX 标题分节 → 节内按段落累积到 ~maxChars 一块；过长段落硬切。
export function chunkMarkdown(content: string, maxChars = 1000): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  let heading = "";
  let buf: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (!text) return;
    if (text.length <= maxChars) {
      chunks.push({ text, heading });
      return;
    }
    for (let i = 0; i < text.length; i += maxChars) {
      const piece = text.slice(i, i + maxChars).trim();
      if (piece) chunks.push({ text: piece, heading });
    }
  };

  for (const line of lines) {
    // 代码围栏（``` 或 ~~~，允许 ≤3 空格缩进）：进入/退出。围栏内所有行原样累积，
    // 不参与标题/段落边界判定——否则代码里的「# 注释」会被当成 Markdown 标题，污染分块与 heading 归属。
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (inFence) {
      buf.push(line);
      continue;
    }
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      flush();
      heading = m[2].trim();
      continue;
    }
    if (line.trim() === "") {
      // 段落边界：若已接近上限就 flush
      if (buf.join("\n").length >= maxChars) flush();
      else buf.push("");
    } else {
      buf.push(line);
    }
  }
  flush();
  return chunks;
}
