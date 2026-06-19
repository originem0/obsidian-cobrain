import { Retriever } from "../rag/retriever";
import { ChatClient, ChatMsg } from "../llm/chatClient";
import type { QueryHit } from "../rag/vectorStore";
import type { CobrainSettings } from "../settings";
import { parseNote } from "../util/noteFormat";

// 概念图详细度档位 → 给 LLM 的节点数指示
const DETAIL_HINT: Record<string, string> = {
  "简": "只画最核心的 5-7 个节点。",
  "中": "约 10 个节点。",
  "详": "尽量完整，15 个以上节点，包含次级关系。",
};

export class Tutor {
  // settings 引用：提示词、概念图方向/详细度等均在调用时读最新值（改设置即时生效）
  constructor(private retriever: Retriever, private chat: ChatClient, private settings: CobrainSettings) {}

  private async retrieveContext(query: string): Promise<{ context: string; sources: string[]; hits: QueryHit[] }> {
    try {
      const hits = await this.retriever.retrieve(query, 6);
      const sources = [...new Set(hits.map(h => h.path))];
      const context = hits.length
        ? "已有笔记（从用户 vault 检索到的相关片段；据此判断用户已知什么，并用 [[路径]] 引用相关的）：\n" +
          hits.map(h => `- [${h.path}${h.heading ? " › " + h.heading : ""}]\n  ${h.text.slice(0, 300)}`).join("\n")
        : "";
      return { context, sources, hits };
    } catch (e) {
      // 检索失败（如维度不一致）不阻断对话：context 置空，错误只记日志，不把错误串当 system 消息注入 LLM
      console.error("Cobrain: 检索失败", e);
      return { context: "", sources: [], hits: [] };
    }
  }

  async ask(history: ChatMsg[], userMsg: string, sourceContext?: string): Promise<{ reply: string; sources: string[]; related: QueryHit[] }> {
    const { context, sources, hits } = await this.retrieveContext(userMsg);
    const messages: ChatMsg[] = [
      { role: "system", content: this.settings.tutorPrompt },
      ...(context ? [{ role: "system" as const, content: context }] : []),
      ...(sourceContext
        ? [{ role: "system" as const, content: "用户正在读的来源片段（据此理解他选中/提问的上下文）：\n" + sourceContext }]
        : []),
      ...history,
      { role: "user", content: userMsg },
    ];
    const reply = await this.chat.chat(messages);
    // related = 检索命中的原始片段，交给 UI 显式呈现给用户（第二大脑「联想」效果），而非只喂给模型
    return { reply, sources, related: hits };
  }

  // 概念图：让 LLM 产出 Mermaid（焦点问题→概念→关系）。方向/详细度由设置注入到提示词。
  async conceptMap(topic: string): Promise<string> {
    const { context } = await this.retrieveContext(topic);
    const dir = this.settings.conceptMapDirection || "TD";
    const detail = DETAIL_HINT[this.settings.conceptMapDetail] ?? DETAIL_HINT["中"];
    const system = `${this.settings.conceptMapPrompt}\n用 \`graph ${dir}\`。${detail}`;
    return this.chat.chat(
      [
        { role: "system", content: system },
        { role: "user", content: `主题：${topic}\n\n参考片段：\n${context}\n\n画出这个主题的概念图。` },
      ],
      { temperature: 0.3, maxTokens: 4096 },
    );
  }

  // 把概念扩写成详细的文生图提示词。图像质量的根因在提示词太简陋，故先让 LLM 构想一个具象画面。
  async imagePrompt(concept: string): Promise<string> {
    return this.chat.chat(
      [
        {
          role: "system",
          content:
            "你是文生图提示词专家。把用户给的概念转化为一段用于图像生成模型的提示词：构想一个能隐喻该概念核心的具体画面，描述主体、场景、动作、构图、光线、色调，尽量具象可画，避免抽象词汇。只输出提示词本身，不要解释、不要加引号。",
        },
        { role: "user", content: `概念：${concept}` },
      ],
      { temperature: 0.8, maxTokens: 600 },
    );
  }

  // 把对话综述成结构化笔记（标题 + 正文），而非聊天记录原文
  async summarizeNote(history: ChatMsg[]): Promise<{ title: string; body: string }> {
    const convo = history
      .map(m => `${m.role === "user" ? "用户" : "副脑"}：${m.content}`)
      .join("\n\n");
    const reply = await this.chat.chat(
      [
        { role: "system", content: this.settings.notePrompt },
        { role: "user", content: convo },
      ],
      { temperature: 0.3, maxTokens: 4096 },
    );
    // 标题/正文解析抽到纯函数（util/noteFormat），便于单测 LLM 不照格式时的回退
    return parseNote(reply);
  }
}
