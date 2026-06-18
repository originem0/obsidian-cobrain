import { Retriever } from "../rag/retriever";
import { ChatClient, ChatMsg } from "../llm/chatClient";

export const TUTOR_SYSTEM = `你是一位「学习导师」，帮助用户真正理解概念，而不是堆砌信息。原则：
- 拆解：把复杂概念拆成更小的部分，逐层讲清，先骨架后细节。
- 按水平讲：参考下面「已有笔记」判断用户已经知道什么，在此基础上推进，别重复他已懂的。
- 接地：尽量关联用户 vault 里已有的相关笔记，用 [[笔记名]] 形式引用，把新知识接到旧知识上。
- 苏格拉底式：适时反问，引导用户自己想一步，而不是一味灌输。
- 中文回答，简洁、有重点；善用类比和具体例子；可用 Markdown。`;

export class Tutor {
  constructor(private retriever: Retriever, private chat: ChatClient) {}

  private async retrieveContext(query: string): Promise<{ context: string; sources: string[] }> {
    try {
      const hits = await this.retriever.retrieve(query, 6);
      const sources = [...new Set(hits.map(h => h.path))];
      const context = hits.length
        ? "已有笔记（从用户 vault 检索到的相关片段；据此判断用户已知什么，并用 [[路径]] 引用相关的）：\n" +
          hits.map(h => `- [${h.path}${h.heading ? " › " + h.heading : ""}]\n  ${h.text.slice(0, 300)}`).join("\n")
        : "";
      return { context, sources };
    } catch (e) {
      // 检索失败（如维度不一致）不阻断对话
      return { context: `（检索暂不可用：${e instanceof Error ? e.message : String(e)}）`, sources: [] };
    }
  }

  async ask(history: ChatMsg[], userMsg: string): Promise<{ reply: string; sources: string[] }> {
    const { context, sources } = await this.retrieveContext(userMsg);
    const messages: ChatMsg[] = [
      { role: "system", content: TUTOR_SYSTEM },
      ...(context ? [{ role: "system" as const, content: context }] : []),
      ...history,
      { role: "user", content: userMsg },
    ];
    const reply = await this.chat.chat(messages);
    return { reply, sources };
  }

  // Plan2-T5 概念图：让 LLM 产出 Mermaid（焦点问题→概念→关系）
  async conceptMap(topic: string): Promise<string> {
    const { context } = await this.retrieveContext(topic);
    return this.chat.chat(
      [
        {
          role: "system",
          content:
            "只输出一个 ```mermaid 代码块，不要任何其它文字。用 `graph TD`：顶部一个焦点问题节点，往下是核心概念，用带中文标签的箭头表示概念间关系。节点文字用中文，简短。",
        },
        { role: "user", content: `主题：${topic}\n\n参考片段：\n${context}\n\n画出这个主题的概念图。` },
      ],
      { temperature: 0.3 },
    );
  }

  // Plan2-T4：把对话综述成结构化笔记（标题 + 正文），而非聊天记录原文
  async summarizeNote(history: ChatMsg[]): Promise<{ title: string; body: string }> {
    const convo = history
      .map(m => `${m.role === "user" ? "用户" : "导师"}：${m.content}`)
      .join("\n\n");
    const reply = await this.chat.chat(
      [
        {
          role: "system",
          content:
            "把下面这段学习对话整理成一篇结构化的中文笔记（不是聊天记录原文）。第一行用 `标题：xxx` 给出简短标题；其后是正文：用小标题和要点组织核心概念、拆解与结论，去掉寒暄口水。Markdown 格式。",
        },
        { role: "user", content: convo },
      ],
      { temperature: 0.3 },
    );
    const m = reply.match(/^标题[：:]\s*(.+)$/m);
    const title = m ? m[1].trim() : "学习笔记";
    const body = reply.replace(/^标题[：:]\s*.+$/m, "").trim();
    return { title, body };
  }
}
