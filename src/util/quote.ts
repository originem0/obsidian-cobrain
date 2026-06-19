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
