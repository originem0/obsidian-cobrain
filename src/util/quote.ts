// 选中文本 → 引用块：逐行 blockquote + 尾部来源链接，末尾留空行供用户接着打疑问。
// 纯函数，不 import obsidian，便于 jest 直接单测。
export function buildQuote(selection: string, linktext: string, heading: string | null): string {
  const quoted = selection.split("\n").map(l => "> " + l).join("\n");
  const target = heading ? `${linktext}#${heading}` : linktext;
  return `${quoted}\n> —— [[${target}]]\n\n`;
}

// 从 fromLine 起向上找最近的 ATX 标题文本（含本行；找不到返回 null）。
// 简单上扫，不处理代码围栏内的 #（少见，可接受）。
export function findHeadingAbove(lines: string[], fromLine: number): string | null {
  for (let i = Math.min(fromLine, lines.length - 1); i >= 0; i--) {
    const m = lines[i].match(/^#{1,6}\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

// 取 fromLine 所在「小节」文本喂给 LLM 作上下文：最近标题(含本行)→ 下一个同级/更高级标题前；
// 无标题则取 fromLine 附近窗口；整体超 maxChars 则取以 fromLine 为中心的窗口。纯函数，可测。
export function extractContext(lines: string[], fromLine: number, maxChars = 1800): string {
  const n = lines.length;
  const clamp = (i: number) => Math.max(0, Math.min(n - 1, i));
  const from = clamp(fromLine);
  let headingLine = -1;
  let level = 0;
  for (let i = from; i >= 0; i--) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m) { headingLine = i; level = m[1].length; break; }
  }
  let start: number;
  let end: number;
  if (headingLine >= 0) {
    start = headingLine;
    end = n - 1;
    for (let i = headingLine + 1; i < n; i++) {
      const m = lines[i].match(/^(#{1,6})\s+/);
      if (m && m[1].length <= level) { end = i - 1; break; }
    }
  } else {
    start = clamp(from - 10);
    end = clamp(from + 10);
  }
  let text = lines.slice(start, end + 1).join("\n").trim();
  if (text.length > maxChars) {
    text = lines.slice(clamp(from - 12), clamp(from + 12) + 1).join("\n").trim();
    if (text.length > maxChars) text = text.slice(0, maxChars);
  }
  return text;
}
