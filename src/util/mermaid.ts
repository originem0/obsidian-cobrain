// 从 LLM 输出里抽出 Mermaid 图，返回规范化的 ```mermaid 代码块；抽不到返回 null。
// 收紧点（相对旧实现）：旧代码只要正文里出现 "graph TD" 就把【整段文字】（含解释性散文）
// 一锅端包进 mermaid 块，渲染必然报错。这里只认真正的图定义。

// 一行是否「像」Mermaid 图的起始声明（graph/flowchart/各类 diagram）。
const DIAGRAM_HEAD =
  /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|mindmap|gantt|pie|journey|gitGraph|quadrantChart|timeline)\b/i;

export function extractMermaid(text: string): string | null {
  // ① 优先：显式 ```mermaid 围栏块
  const tagged = text.match(/```mermaid\s*\n([\s\S]*?)```/i);
  if (tagged) return "```mermaid\n" + tagged[1].trim() + "\n```";

  // ② 任意 ``` 围栏块，且块内首个非空内容像图定义（应对 LLM 漏写 mermaid 标签）
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  let mm: RegExpExecArray | null;
  while ((mm = fenceRe.exec(text))) {
    const inner = mm[1].trim();
    if (DIAGRAM_HEAD.test(inner)) return "```mermaid\n" + inner + "\n```";
  }

  // ③ 完全无围栏：仅当整段（去首尾空白后）本身就以图定义开头才包裹，
  // 避免把「这是概念图：\ngraph TD…」这类带散文前缀的输出整段卷进 mermaid 块。
  const bare = text.trim();
  if (DIAGRAM_HEAD.test(bare)) return "```mermaid\n" + bare + "\n```";

  return null;
}
