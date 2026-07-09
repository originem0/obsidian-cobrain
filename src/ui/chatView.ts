import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, TFile, Menu, normalizePath } from "obsidian";
import type { ChatMsg } from "../llm/chatClient";
import type { QueryHit } from "../rag/vectorStore";
import { saveNote, saveImage } from "../noteWriter";
import { extractMermaid } from "../util/mermaid";
import { fnv1a } from "../util/hash";
import { CancelledError, makeCancellable } from "../util/cancellable";
import { SUMMARY_HISTORY_LIMIT } from "../tutor/tutor";
import type CobrainPlugin from "../main";
import type { SavedNoteState, ContextSummaryState } from "../main";
import { askPrompt, askTextArea, askConfirm, askSaveOptions } from "./modals";

export const VIEW_TYPE_COBRAIN_CHAT = "cobrain-chat";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const CHAT_CONTEXT_MSG_LIMIT = 20;
// 滚动摘要攒批阈值：窗口外未覆盖的消息不足这个数就先不总结，避免每来一条就打一次摘要请求
const SUMMARY_BATCH_MIN = 6;

export function chatStateSignature(
  history: ChatMsg[],
  sources: string[],
  mermaid: string | null,
  imageEmbed: string | null,
): string {
  return fnv1a(JSON.stringify({
    history,
    sources: [...sources].sort(),
    mermaid,
    imageEmbed,
  }));
}

export function chatHistoryForModel(history: ChatMsg[]): ChatMsg[] {
  return history.slice(-CHAT_CONTEXT_MSG_LIMIT);
}

// 截断提示随摘要状态分档：全覆盖 / 部分覆盖（摘要在攒批或更新中）/ 尚无摘要。
export function chatContextLimitText(historyLength: number, summarizedCount = 0): string | null {
  const overflow = historyLength - CHAT_CONTEXT_MSG_LIMIT;
  if (overflow <= 0) return null;
  if (summarizedCount >= overflow) return `更早的 ${overflow} 条消息已压缩成滚动摘要，随本轮对话一起发给模型。`;
  if (summarizedCount > 0) return `更早的 ${overflow} 条消息中 ${summarizedCount} 条已压缩成滚动摘要；其余 ${overflow - summarizedCount} 条待下次压缩，本轮不发给模型。`;
  return `更早的 ${overflow} 条消息暂未发给模型（对话继续时会自动压缩成滚动摘要）。`;
}

// 摘要批计算（纯函数）：返回本次应并入摘要的 history 区间 [from, to)，不足攒批阈值返回 null。
// to 恒为「窗口左边界」——只总结已滑出 20 条窗口的消息，窗口内的始终原文发送、不摘要。
export function summaryUpdatePlan(
  historyLength: number,
  coveredCount: number,
  windowLimit = CHAT_CONTEXT_MSG_LIMIT,
  batchMin = SUMMARY_BATCH_MIN,
): { from: number; to: number } | null {
  const overflowEnd = historyLength - windowLimit;
  if (overflowEnd - coveredCount < batchMin) return null;
  return { from: coveredCount, to: overflowEnd };
}

export interface SaveSnapshot {
  history: ChatMsg[];
  sources: string[];
  mermaid: string | null;
  imageEmbed: string | null;
}

// 保存成功后的状态消费（纯函数）：只清掉本次快照真正用掉的产物——
// 保存弹窗/出图期间用户继续聊天或重新生成的新产物不能被误清。
// 不变量：保存后若用户未再改动，当前状态签名 chatStateSignature(history, [...sources], mermaid, image)
// 与这里记录的 lastSavedNote.stateSignature 相等，重复点「存为笔记」命中去重。
// 若改动清空口径，务必同步签名参数，否则去重会失效或误判。
export function consumeSavedSnapshot(
  current: { lastMermaid: string | null; lastImageEmbed: string | null },
  snapshot: SaveSnapshot,
  path: string,
  savedAt: number,
): { lastMermaid: string | null; lastImageEmbed: string | null; consumedSources: string[]; lastSavedNote: SavedNoteState } {
  return {
    lastMermaid: current.lastMermaid === snapshot.mermaid ? null : current.lastMermaid,
    lastImageEmbed: current.lastImageEmbed === snapshot.imageEmbed ? null : current.lastImageEmbed,
    consumedSources: snapshot.sources,
    lastSavedNote: {
      stateSignature: chatStateSignature(snapshot.history, [], null, null),
      path,
      savedAt,
    },
  };
}

// 带秒数计时的 Notice：用于构思配图主题/扩写提示词/整理笔记等不在气泡里展示的等待。
function timedNotice(label: string): { notice: Notice; stop: () => void } {
  const start = Date.now();
  const notice = new Notice(`${label} 0s`, 0);
  const timer = window.setInterval(() => {
    notice.setMessage(`${label} ${Math.floor((Date.now() - start) / 1000)}s`);
  }, 1000);
  return { notice, stop: () => { window.clearInterval(timer); notice.hide(); } };
}

function isUnderFolder(path: string, folder: string): boolean {
  const p = normalizePath(path);
  const f = normalizePath(folder).replace(/\/+$/, "");
  return !!f && p.startsWith(f + "/");
}

// 流式回答气泡的控制柄（见 ChatView.streamingBubble）
interface StreamBubble {
  el: HTMLElement;
  append: (text: string) => void;
  finish: (fullText: string) => Promise<void>;
  remove: () => void;
}

export class ChatView extends ItemView {
  private history: ChatMsg[] = [];
  private sources = new Set<string>();
  private lastMermaid: string | null = null;
  private lastImageEmbed: string | null = null;
  private lastSavedNote: SavedNoteState | null = null;
  private contextSummary: ContextSummaryState | null = null;
  // 清空/关闭面板时 +1：使在途的后台摘要任务作废，避免迟到结果写进已清空的对话或已关闭的面板
  private summaryGen = 0;
  private summaryInFlight = false;
  private messagesEl!: HTMLElement;
  private welcomeEl!: HTMLElement;
  private contextLimitEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private actionButtons: HTMLButtonElement[] = [];
  private saveNoteBtn!: HTMLButtonElement;
  private busy = false; // 一次只跑一轮 ask，避免连发导致 history 交错
  private currentCancel: (() => void) | null = null; // 「停止」按钮：拒绝当前在途请求（UI 立即解锁）
  private currentAbort: AbortController | null = null; // 「停止」同时中止底层 fetch（流式路径真正停掉请求）
  private pendingSourceContexts: string[] = []; // 引用带来的源笔记小节，只喂给紧接着的那一问
  private instanceId: number; // 实例 ID（1/2/3）

  constructor(leaf: WorkspaceLeaf, private plugin: CobrainPlugin, instanceId: number = 1) {
    super(leaf);
    this.instanceId = instanceId;
  }

  getViewType(): string { return `${VIEW_TYPE_COBRAIN_CHAT}-${this.instanceId}`; }
  getDisplayText(): string { return `创作副脑 #${this.instanceId}`; }
  getIcon(): string { return "brain"; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("cobrain-root");

    this.messagesEl = root.createDiv({ cls: "cobrain-messages" });
    this.renderWelcome();

    const draft = this.plugin.getChatDraft(this.instanceId);
    if (draft) {
      this.history = [...draft.history];
      this.sources = new Set(draft.sources);
      this.lastMermaid = draft.lastMermaid;
      this.lastImageEmbed = draft.lastImageEmbed;
      this.lastSavedNote = draft.lastSavedNote;
      this.contextSummary = draft.contextSummary;
      this.addRestoredLine();
      for (const msg of this.history) {
        if (msg.role === "user" || msg.role === "assistant") this.addBubble(msg.role, msg.content);
      }
      if (this.lastSavedNote) this.addSavedNoteLine(this.lastSavedNote.path);
    }

    // 截断/摘要提示放输入区上方而非消息流顶部：长对话时消息流顶部永远滚出视野，提示形同虚设
    this.contextLimitEl = root.createDiv({ cls: "cobrain-context-limit" });

    const bar = root.createDiv({ cls: "cobrain-bar" });
    this.makeBtn(bar, "概念图", () => void this.doConceptMap());
    this.makeBtn(bar, "推敲", () => void this.doCritique());
    this.makeBtn(bar, "配图", () => void this.doImage());
    this.saveNoteBtn = this.makeBtn(bar, "存为笔记", () => void this.doSaveNote());
    this.makeBtn(bar, "清空", () => void this.doClearDraft());

    const iw = root.createDiv({ cls: "cobrain-inputrow" });
    this.inputEl = iw.createEl("textarea", {
      cls: "cobrain-input",
      attr: { rows: "1", placeholder: "问副脑…（Enter 发送，Shift+Enter 换行）" },
    });
    this.sendBtn = iw.createEl("button", { text: "发送" });
    this.sendBtn.onclick = () => void this.send();
    this.inputEl.addEventListener("input", () => this.autoGrow());
    this.inputEl.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
    this.autoGrow();
    this.updateContextLimitNotice();
    this.updateActionButtons();
  }

  // 输入框随内容长高；上限与滚动由 CSS（.cobrain-input 的 max-height/overflow）封顶。
  private autoGrow(): void {
    this.inputEl.setCssStyles({ height: "auto" });
    this.inputEl.setCssStyles({ height: this.inputEl.scrollHeight + "px" });
  }

  private makeBtn(parent: HTMLElement, text: string, fn: () => void): HTMLButtonElement {
    const b = parent.createEl("button", { text });
    b.onclick = fn;
    this.actionButtons.push(b);
    return b;
  }

  private renderWelcome(): void {
    this.welcomeEl = this.messagesEl.createDiv({ cls: "cobrain-welcome" });
    this.paintWelcome();
    void this.plugin.whenIndexReady().then(
      () => this.paintWelcome(),
      () => undefined,
    );
  }

  // welcome 可重绘（索引加载完成后状态会变）：文案 + 空状态行动按钮——指路不如直达。
  private paintWelcome(): void {
    const el = this.welcomeEl;
    el.empty();
    el.createDiv({ text: this.plugin.chatWelcomeText() });
    const actions = this.plugin.welcomeActions();
    if (!actions.openSettings && !actions.rebuildIndex) return;
    const row = el.createDiv({ cls: "cobrain-welcome-actions" });
    if (actions.openSettings) {
      row.createEl("button", { text: "打开设置" }).onclick = () => this.plugin.openPluginSettings();
    }
    if (actions.rebuildIndex) {
      const btn = row.createEl("button", { text: "重建索引" });
      btn.onclick = () => {
        btn.disabled = true; // 重建在后台跑（进度见 Notice），防重复点击
        void this.plugin.rebuildIndex();
      };
    }
  }

  // 「已恢复草稿」提示行 + 轻量「新建对话」入口：恢复是默认路径（打开面板零打断），
  // 想重来的人在这里点新建（走清空确认，防误删草稿）。取代原先打开面板时的拦路三选弹窗。
  private addRestoredLine(): void {
    const line = this.messagesEl.createDiv({ cls: "cobrain-restored" });
    line.createSpan({ text: "已恢复上次未关闭的对话草稿。" });
    const fresh = line.createEl("a", { text: "新建对话", cls: "cobrain-inline-action" });
    fresh.onclick = () => void this.doClearDraft();
  }

  // 保存闭环：消息流里留一行可点开的「已保存」，别让产品的奖励时刻消失在几秒的 Notice 里。
  private addSavedNoteLine(path: string): void {
    const line = this.messagesEl.createDiv({ cls: "cobrain-saved-line" });
    line.createSpan({ text: "已保存笔记：" });
    const name = (path.split("/").pop() ?? path).replace(/\.md$/, "");
    line.createEl("a", { text: name }).onclick = () => void this.app.workspace.openLinkText(path, "", false);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  // 带可点链接的保存 Notice（Notice 接受 DocumentFragment）。
  private savedNotice(prefix: string, path: string): void {
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(prefix));
    const a = document.createElement("a");
    a.textContent = (path.split("/").pop() ?? path).replace(/\.md$/, "");
    a.addEventListener("click", () => void this.app.workspace.openLinkText(path, "", false));
    frag.appendChild(a);
    new Notice(frag, 8000);
  }

  private persistDraft(): void {
    this.plugin.saveChatDraft(this.instanceId, {
      history: this.history,
      sources: [...this.sources],
      lastMermaid: this.lastMermaid,
      lastImageEmbed: this.lastImageEmbed,
      lastSavedNote: this.lastSavedNote,
      contextSummary: this.contextSummary,
    });
  }

  private updateActionButtons(): void {
    const hasHistory = this.history.length > 0;
    for (const b of this.actionButtons) b.disabled = this.busy || !hasHistory;
    if (this.saveNoteBtn) {
      this.saveNoteBtn.disabled = this.busy || !hasHistory;
      this.saveNoteBtn.setText("存为笔记");
    }
  }

  private updateContextLimitNotice(): void {
    if (!this.contextLimitEl) return;
    const text = chatContextLimitText(this.history.length, this.contextSummary?.coveredCount ?? 0);
    if (text) {
      this.contextLimitEl.setText(text);
      this.contextLimitEl.style.display = "";
    } else {
      this.contextLimitEl.setText("");
      this.contextLimitEl.style.display = "none";
    }
  }

  private appendHistory(...msgs: ChatMsg[]): void {
    this.history.push(...msgs);
    this.updateContextLimitNotice();
    this.updateActionButtons();
    this.persistDraft();
  }

  private resetConversationUi(): void {
    this.messagesEl.empty();
    this.renderWelcome();
    this.updateContextLimitNotice();
    this.updateActionButtons();
  }

  private stateSignature(
    history: ChatMsg[] = this.history,
    sources: string[] = [...this.sources],
    mermaid: string | null = this.lastMermaid,
    imageEmbed: string | null = this.lastImageEmbed,
  ): string {
    return chatStateSignature(history, sources, mermaid, imageEmbed);
  }

  // 滑出 limit 条窗口时把滚动摘要作为背景材料带上；窗口装得下就不带（全部原文在场，摘要是冗余）。
  // effectiveLength：performAsk 在 user 消息入历史后调用，需要按「不含末尾这条」的长度判断。
  private earlierSummaryFor(limit: number, effectiveLength = this.history.length): string | undefined {
    if (!this.contextSummary?.text) return undefined;
    return effectiveLength > limit ? this.contextSummary.text : undefined;
  }

  // 后台维护滚动摘要：把滑出 20 条窗口、尚未纳入摘要的旧消息并入既有摘要。
  // fire-and-forget：失败只记日志、下轮对话自动重试；generation 计数使清空/关闭后的迟到结果作废。
  private maybeUpdateSummary(): void {
    const plan = summaryUpdatePlan(this.history.length, this.contextSummary?.coveredCount ?? 0);
    if (!plan || this.summaryInFlight) return;
    if (this.plugin.chatConfigProblem()) return;
    const gen = this.summaryGen;
    const dropped = this.history.slice(plan.from, plan.to);
    const prev = this.contextSummary?.text ?? "";
    this.summaryInFlight = true;
    this.plugin.tutor.updateRollingSummary(prev, dropped)
      .then(text => {
        if (gen !== this.summaryGen || !text) return;
        this.contextSummary = { text, coveredCount: plan.to };
        this.updateContextLimitNotice();
        this.persistDraft();
      })
      .catch(e => console.warn("Cobrain: 滚动摘要更新失败（下轮自动重试）", e))
      .finally(() => { this.summaryInFlight = false; });
  }

  private addBubble(role: "user" | "assistant", text: string, sources?: string[]): HTMLElement {
    const b = this.messagesEl.createDiv({ cls: `cobrain-bubble cobrain-bubble-${role === "user" ? "user" : "ai"}` });
    const who = b.createDiv({ cls: "cobrain-who" });
    who.createSpan({ text: role === "user" ? "你" : "副脑" });
    if (role === "assistant") this.addCopyControl(who, () => text);
    const body = b.createDiv();

    if (role === "assistant") {
      void this.renderAssistant(body, text);
    } else {
      body.setText(text);
    }

    if (sources?.length) {
      b.createDiv({ cls: "cobrain-srcline", text: "来源：" + sources.map(p => p.split("/").pop()).join("、") });
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return b;
  }

  // AI 气泡「复制」：面板文字虽已放开选中，但移动端长按选择很痛苦，明确的复制入口是地板配置。
  private addCopyControl(whoEl: HTMLElement, getText: () => string): void {
    const btn = whoEl.createEl("a", { text: "复制", cls: "cobrain-copy" });
    btn.onclick = async e => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(getText());
        new Notice("已复制");
      } catch {
        new Notice("复制失败");
      }
    };
  }

  // 流式回答气泡：创建即显示「label + 秒数」计时；首个增量到达后切换为逐字纯文本；
  // finish() 用完整文本做一次 Markdown 渲染（流式期间渲染半截 Markdown 会闪烁/错排，纯文本最稳）。
  private streamingBubble(label: string): StreamBubble {
    const el = this.messagesEl.createDiv({ cls: "cobrain-bubble cobrain-bubble-ai" });
    let acc = "";
    let fullText = "";
    const who = el.createDiv({ cls: "cobrain-who" });
    who.createSpan({ text: "副脑" });
    // 流式中点复制拿到已流出的部分，完成后拿全文
    this.addCopyControl(who, () => fullText || acc);
    const body = el.createDiv();
    const labelSpan = body.createSpan({ text: label });
    const secSpan = body.createSpan({ text: " 0s", cls: "cobrain-timer" });
    secSpan.setCssStyles({ opacity: "0.6", fontSize: "0.9em" });
    const start = Date.now();
    let timer: number | null = window.setInterval(() => {
      secSpan.setText(" " + Math.floor((Date.now() - start) / 1000) + "s");
    }, 1000);
    const stopTimer = () => {
      if (timer !== null) { window.clearInterval(timer); timer = null; }
    };
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    let streamEl: HTMLElement | null = null;
    return {
      el,
      append: (text: string) => {
        if (!streamEl) {
          stopTimer();
          labelSpan.remove();
          secSpan.remove();
          streamEl = body.createDiv({ cls: "cobrain-stream" });
        }
        acc += text;
        // 逐字更新期间只在用户本来就贴着底部时才跟随滚动，别抢用户往回翻的滚动条
        const nearBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 60;
        streamEl.setText(acc);
        if (nearBottom) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      },
      finish: async (text: string) => {
        fullText = text;
        stopTimer();
        body.empty();
        await this.renderAssistant(body, text);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      },
      remove: () => { stopTimer(); el.remove(); },
    };
  }

  // 渲染助手消息：先 await Markdown 渲染，再挂 Mermaid 切换 / 配图交互。
  private async renderAssistant(body: HTMLElement, text: string): Promise<void> {
    await MarkdownRenderer.render(this.app, text, body, "", this);
    const mermaidMatch = text.match(/```mermaid\n([\s\S]*?)```/);
    if (mermaidMatch) await this.enhanceMermaid(body, mermaidMatch[1].trim());
    const imageMatch = text.match(/!\[\[([^\]]+)\]\]/);
    if (imageMatch) await this.enhanceImage(body, imageMatch[1]);
  }

  // 等 root 内出现匹配 selector 的元素（应对 Obsidian/Mermaid 的异步渲染），最多等 timeoutMs。
  private waitForElement(root: HTMLElement, selector: string, timeoutMs = 2000): Promise<HTMLElement | null> {
    const found = (): HTMLElement | null => {
      const el = root.querySelector(selector);
      return el instanceof HTMLElement ? el : null;
    };
    const existing = found();
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      let done = false;
      const finish = (el: HTMLElement | null) => {
        if (done) return;
        done = true;
        obs.disconnect();
        window.clearTimeout(timer);
        resolve(el);
      };
      const obs = new MutationObserver(() => {
        const el = found();
        if (el) finish(el);
      });
      obs.observe(root, { childList: true, subtree: true });
      const timer = window.setTimeout(() => finish(found()), timeoutMs);
    });
  }

  // 点击 Mermaid 图 ↔ 查看其源码。
  private async enhanceMermaid(body: HTMLElement, code: string): Promise<void> {
    const container = await this.waitForElement(body, "pre.language-mermaid, .block-language-mermaid, [class*='mermaid']");
    if (!container) return;
    let showingCode = false;
    const rendered = container.cloneNode(true) as HTMLElement; // 保存渲染视图
    container.addClass("cobrain-mermaid-toggle");
    container.setAttribute("title", "点击查看代码");
    container.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      if (showingCode) {
        container.empty();
        container.appendChild(rendered.cloneNode(true));
        container.setAttribute("title", "点击查看代码");
        showingCode = false;
      } else {
        container.empty();
        const pre = container.createEl("pre", { cls: "cobrain-mermaid-code" });
        pre.createEl("code", { text: code });
        container.setAttribute("title", "点击返回图表");
        showingCode = true;
      }
    };
  }

  // 配图缩略图 + 单击查看大图 + 右键菜单（另存 / 删除）。
  private async enhanceImage(body: HTMLElement, imagePath: string): Promise<void> {
    const base = imagePath.split("/").pop() ?? imagePath;
    // 等任意 img 渲染出来，再按 src 里的文件名匹配目标图（避免拼 CSS 选择器的转义问题）
    await this.waitForElement(body, "img");
    const imgEl = Array.from(body.querySelectorAll("img")).find(im => {
      const src = im.getAttribute("src") || "";
      try { return decodeURIComponent(src).includes(base); } catch { return src.includes(base); }
    });
    if (!(imgEl instanceof HTMLImageElement)) return;

    imgEl.addClass("cobrain-image-thumb");
    imgEl.setAttribute("title", "单击查看大图");
    imgEl.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      const file = this.app.vault.getAbstractFileByPath(imagePath);
      if (file instanceof TFile) this.app.workspace.getLeaf(false).openFile(file);
    };
    imgEl.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem(item =>
        item.setTitle("单独保存配图").setIcon("download").onClick(async () => {
          const file = this.app.vault.getAbstractFileByPath(imagePath);
          if (!(file instanceof TFile)) return;
          try {
            const content = await this.app.vault.readBinary(file);
            const newPath = await saveImage(this.app, this.plugin.settings, content);
            new Notice(`配图已另存为：${newPath}`);
          } catch (err) {
            new Notice("保存失败：" + errMsg(err));
          }
        }),
      );
      menu.addItem(item =>
        item.setTitle("删除配图").setIcon("trash").onClick(async () => {
          const file = this.app.vault.getAbstractFileByPath(imagePath);
          if (!(file instanceof TFile)) return;
          const folder = this.plugin.settings.attachmentFolder || "cobrain-note/附件";
          if (!isUnderFolder(file.path, folder)) {
            new Notice("只能删除附件目录内的 Cobrain 配图");
            return;
          }
          const confirmed = await askConfirm(this.app, "删除配图", `确定删除 ${file.path}？`, "删除");
          if (!confirmed) return;
          try {
            await this.app.vault.delete(file);
            new Notice("配图已删除");
            imgEl.remove();
          } catch (err) {
            new Notice("删除失败：" + errMsg(err));
          }
        }),
      );
      menu.showAtMouseEvent(e);
    });
  }

  // 把检索命中的旧笔记显式列出来、可点开，让第二大脑的联想发生在用户眼前。
  // before 提供时插到该元素前面：流式场景下气泡先创建、检索结果后到，仍保持「相关笔记在上、回答在下」。
  // 新一轮出现时折叠此前所有相关块（头部可点击展开）：每块占侧栏半屏，长对话里会淹没对话本身。
  private addRelatedBlock(hits: QueryHit[], before?: HTMLElement): void {
    if (!hits.length) return;
    this.messagesEl.querySelectorAll(".cobrain-related").forEach(el => el.classList.add("is-collapsed"));
    const seen = new Set<string>();
    const uniq = hits.filter(h => {
      if (seen.has(h.path)) return false;
      seen.add(h.path);
      return true;
    });
    const wrap = this.messagesEl.createDiv({ cls: "cobrain-related" });
    if (before) this.messagesEl.insertBefore(wrap, before);
    const shown = uniq.slice(0, 8);
    const head = wrap.createDiv({ cls: "cobrain-related-head", text: `相关旧笔记 · ${shown.length} 篇` });
    head.setAttribute("title", "点击折叠 / 展开");
    head.onclick = () => wrap.classList.toggle("is-collapsed");
    shown.forEach(h => {
      const item = wrap.createDiv({ cls: "cobrain-related-item" });
      const title = (h.path.split("/").pop() ?? h.path).replace(/\.md$/, "") + (h.heading ? " › " + h.heading : "");
      item.createDiv({ cls: "cobrain-related-title", text: title });
      item.createDiv({ cls: "cobrain-related-snippet", text: h.text.slice(0, 80) + (h.text.length > 80 ? "…" : "") });
      item.onclick = () => this.app.workspace.openLinkText(h.path, "", false);
    });
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  // 检索空命中不再静默：让用户能区分「vault 里真没有相关」和「没配置 / 阈值卡掉了」。
  private addNoHitLine(before?: HTMLElement): void {
    const line = this.messagesEl.createDiv({ cls: "cobrain-nohit", text: "本轮未命中相关旧笔记" });
    if (before) this.messagesEl.insertBefore(line, before);
  }

  private currentTopic(): string {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "user") return this.history[i].content;
    }
    return "";
  }

  // 占用面板：busy 期间禁用输入，发送键变「停止」，三个按钮互斥避免并发交错。
  // 每次占用配一个新 AbortController：走 fetch 的请求可被「停止」真正中止。
  private acquire(): boolean {
    if (this.busy) { new Notice("正在处理上一个请求，请稍候…"); return false; }
    this.busy = true;
    this.currentAbort = new AbortController();
    this.inputEl.disabled = true;
    this.sendBtn.disabled = false;
    this.sendBtn.setText("停止");
    this.sendBtn.onclick = () => this.cancelCurrent();
    this.updateActionButtons();
    return true;
  }
  private release(): void {
    this.busy = false;
    this.currentCancel = null;
    this.currentAbort = null;
    this.inputEl.disabled = false;
    this.sendBtn.disabled = false;
    this.sendBtn.setText("发送");
    this.sendBtn.onclick = () => void this.send();
    this.updateActionButtons();
  }

  private currentSignal(): AbortSignal | undefined {
    return this.currentAbort?.signal;
  }

  // 点「停止」：中止底层 fetch（流式路径请求真正停掉），并拒绝在途等待、立即解锁 UI。
  // requestUrl 兜底路径无法中止：那种情况下停止只是放弃结果，请求仍会在后台跑完。
  private cancelCurrent(): void {
    if (!this.currentCancel && !this.currentAbort) return;
    this.currentAbort?.abort();
    this.currentCancel?.();
    new Notice("已停止");
  }

  // 把一次网络等待包成可取消（makeCancellable 的竞速）：点「停止」即 reject，UI 立即解锁。
  private runCancellable<T>(p: Promise<T>): Promise<T> {
    const { result, cancel } = makeCancellable(p);
    this.currentCancel = cancel;
    return result.finally(() => { this.currentCancel = null; });
  }

  // 把"引用"(来源链接 + 原文)预填进输入框；来源上下文暂存，喂给紧接着的那一问。
  quoteIntoInput(text: string, sourceContext?: string): void {
    if (sourceContext) this.pendingSourceContexts.push(sourceContext);
    this.inputEl.value = text + this.inputEl.value;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(text.length, text.length);
    this.autoGrow();
    this.inputEl.scrollTop = 0; // 引用在顶部，确保可见
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    const configProblem = this.plugin.chatConfigProblem();
    if (configProblem) {
      new Notice(configProblem);
      return;
    }
    if (!this.acquire()) return; // 占住面板；busy 时输入原样留在框里，不被吞
    const sourceContext = this.pendingSourceContexts.length
      ? this.pendingSourceContexts.join("\n\n---\n\n")
      : undefined; // 消费一次：仅这一问带来源上下文
    this.pendingSourceContexts = [];
    this.inputEl.value = "";
    this.autoGrow();
    this.addBubble("user", text);
    this.appendHistory({ role: "user", content: text });
    await this.performAsk(text, sourceContext);
  }

  // 失败后的「重试」入口：history 末尾已有这条 user 消息，不再重复入历史/加气泡。
  private async retryAsk(text: string, sourceContext?: string): Promise<void> {
    if (!this.acquire()) return;
    await this.performAsk(text, sourceContext);
  }

  // 一轮提问的主体。前提：已 acquire，且 history 末尾就是本条 user 消息（send 与重试共用）。
  private async performAsk(text: string, sourceContext?: string): Promise<void> {
    // priorHistory 不含末尾这条正在问的消息（tutor.ask 会单独拼 userMsg）；摘要窗口口径与之对齐
    const priorHistory = chatHistoryForModel(this.history.slice(0, -1));
    const earlierSummary = this.earlierSummaryFor(CHAT_CONTEXT_MSG_LIMIT, this.history.length - 1);
    const bubble = this.streamingBubble("思考中…");
    let streamed = "";
    let retrievedSources: string[] = []; // 检索一完成就记下：中途停止但保留部分回答时，来源同样要入账
    let settled = false; // 取消/完成后到达的迟到增量与检索回调不再上屏
    try {
      const { reply, sources } = await this.runCancellable(this.plugin.tutor.ask(priorHistory, text, {
        sourceContext,
        earlierSummary,
        signal: this.currentSignal(),
        onRetrieved: (related, sources) => {
          if (settled) return;
          retrievedSources = sources;
          if (related.length) this.addRelatedBlock(related, bubble.el);
          else if (!this.plugin.embedConfigProblem()) this.addNoHitLine(bubble.el);
        },
        onDelta: t => {
          if (settled) return;
          streamed += t;
          bubble.append(t);
        },
      }));
      settled = true;
      await bubble.finish(reply);
      sources.forEach(s => this.sources.add(s));
      this.appendHistory({ role: "assistant", content: reply });
      this.maybeUpdateSummary();
    } catch (e) {
      settled = true;
      if (e instanceof CancelledError) {
        // 已流出的部分回答保留并入历史：用户看到了它，重开面板不该凭空消失
        if (streamed.trim()) {
          await bubble.finish(streamed);
          retrievedSources.forEach(s => this.sources.add(s));
          this.appendHistory({ role: "assistant", content: streamed });
        } else bubble.remove();
      } else {
        bubble.remove();
        this.addErrorBubble(errMsg(e), () => void this.retryAsk(text, sourceContext));
        this.persistDraft();
      }
    } finally {
      this.release();
      this.inputEl.focus();
    }
  }

  // 错误气泡 + 重试：失败不该让用户重新组织上一问。错误本身不入历史（重开面板即消失），重试成功后自然接上。
  private addErrorBubble(message: string, retry: () => void): void {
    const b = this.messagesEl.createDiv({ cls: "cobrain-bubble cobrain-bubble-ai" });
    b.createDiv({ cls: "cobrain-who", text: "副脑" });
    b.createDiv({ text: "出错了：" + message });
    const row = b.createDiv({ cls: "cobrain-bubble-actions" });
    const btn = row.createEl("button", { text: "重试", cls: "cobrain-action-btn" });
    btn.onclick = () => { b.remove(); retry(); };
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  // 概念图就地迭代控制：方向/详细度是「画完不满意」时的高频调整项，埋在设置页等于每次重画都要跑一趟设置。
  // 点击即改设置（持久化）并追加重画一张，旧图保留便于对比。
  private addConceptMapControls(bubbleEl: HTMLElement): void {
    const s = this.plugin.settings;
    const row = bubbleEl.createDiv({ cls: "cobrain-bubble-actions" });
    const redraw = (mutate: () => void) => {
      mutate();
      this.plugin.saveSettingsDebounced();
      void this.doConceptMap();
    };
    const dir = row.createEl("button", {
      cls: "cobrain-action-btn",
      text: s.conceptMapDirection === "TD" ? "改左右布局重画" : "改上下布局重画",
    });
    dir.onclick = () => redraw(() => {
      s.conceptMapDirection = s.conceptMapDirection === "TD" ? "LR" : "TD";
    });
    for (const d of ["简", "中", "详"] as const) {
      const b = row.createEl("button", { text: d, cls: "cobrain-action-btn" });
      b.disabled = s.conceptMapDetail === d;
      b.setAttribute("title", `以「${d}」详细度重画`);
      b.onclick = () => redraw(() => { s.conceptMapDetail = d; });
    }
  }

  private async doConceptMap(): Promise<void> {
    if (!this.history.length) {
      new Notice("先聊点什么，再画概念图");
      return;
    }    if (!this.acquire()) return;
    const bubble = this.streamingBubble("画概念图中…");
    try {
      // 概念图不逐字流式：半截 Mermaid 渲染不出来，等完整结果一次上屏
      const raw = await this.runCancellable(this.plugin.tutor.conceptMap(this.history, {
        signal: this.currentSignal(),
        earlierSummary: this.earlierSummaryFor(SUMMARY_HISTORY_LIMIT),
      }));
      this.lastMermaid = extractMermaid(raw);
      await bubble.finish(this.lastMermaid ?? "（未能生成有效的概念图）\n\n" + raw);
      this.addConceptMapControls(bubble.el);
      this.persistDraft();
    } catch (e) {
      this.lastMermaid = null; // 失败不保留上一个话题的旧图，避免存笔记时把陈旧图串进去
      bubble.remove();
      if (!(e instanceof CancelledError)) this.addBubble("assistant", "概念图失败：" + errMsg(e));
    } finally {
      this.release();
    }
  }

  private async doCritique(): Promise<void> {
    if (!this.history.length) {
      new Notice("还没有对话可推敲");
      return;
    }
    if (!this.acquire()) return;
    const bubble = this.streamingBubble("推敲中…");
    let streamed = "";
    let settled = false;
    try {
      const reply = await this.runCancellable(this.plugin.tutor.critique(this.history, {
        signal: this.currentSignal(),
        earlierSummary: this.earlierSummaryFor(SUMMARY_HISTORY_LIMIT),
        onDelta: t => {
          if (settled) return;
          streamed += t;
          bubble.append(t);
        },
      }));
      settled = true;
      await bubble.finish(reply);
      this.appendHistory({ role: "assistant", content: reply });
      this.maybeUpdateSummary();
    } catch (e) {
      settled = true;
      if (e instanceof CancelledError) {
        if (streamed.trim()) {
          await bubble.finish(streamed);
          this.appendHistory({ role: "assistant", content: streamed });
        } else bubble.remove();
      } else {
        bubble.remove();
        this.addBubble("assistant", "推敲失败：" + errMsg(e));
      }
    } finally {
      this.release();
    }
  }

  // 配图：先从对话提炼「值得画的概念 + 隐喻」作为预填（默认是你最后一句话，常是提问、画了没意义），
  // 你可改概念 → LLM 扩写成详细视觉提示词 → 你编辑确认 → 出图。
  private async doImage(): Promise<void> {
    let seed = this.currentTopic();
    if (this.history.length) {
      if (!this.acquire()) return;
      const t = timedNotice("构思配图主题中…");
      let cancelled = false;
      try {
        seed = await this.runCancellable(this.plugin.tutor.imageConcept(this.history, this.currentSignal()));
      } catch (e) {
        if (e instanceof CancelledError) cancelled = true;
        // 其它失败：回退到最近发言，不打断配图
      } finally {
        t.stop();
        this.release();
      }
      if (cancelled) return; // 停止：中止整个配图流程
    }
    if (!seed) { new Notice("先聊点什么，再配图"); return; }
    const concept = await askPrompt(this.app, "给哪个概念配图？", seed);
    if (concept) await this.runImageFromConcept(concept);
  }

  // 概念 → 扩写视觉提示词 → 编辑确认 → 出图 → 嵌入。doImage 与「存为笔记」的可选配图共用。
  // 成功返回 ![[path]] 并存入 lastImageEmbed；任意环节取消/失败返回 null。
  private async runImageFromConcept(concept: string): Promise<string | null> {
    if (!this.acquire()) return null;
    let scene: string;
    const t = timedNotice("扩写配图提示词中…");
    try {
      scene = await this.runCancellable(this.plugin.tutor.imagePrompt(concept, this.currentSignal()));
    } catch (e) {
      if (!(e instanceof CancelledError)) new Notice("提示词扩写失败：" + errMsg(e));
      return null;
    } finally {
      t.stop();
      this.release(); // 扩写完即释放：用户编辑提示词期间不该锁住对话面板
    }
    const style = this.plugin.settings.imageStyle;
    const fullPrompt = [scene.trim(), style ? `风格：${style}` : "", "画面中不要出现任何文字。"]
      .filter(Boolean)
      .join("\n\n");
    const finalPrompt = await askTextArea(this.app, "确认 / 编辑配图提示词", fullPrompt);
    if (!finalPrompt) return null;
    if (!this.acquire()) return null;
    const bubble = this.streamingBubble(`为「${concept}」配图中…（图像生成较慢，约 1 分钟）`);
    try {
      const buf = await this.runCancellable(this.plugin.image.generate(finalPrompt));
      const path = await saveImage(this.app, this.plugin.settings, buf);
      this.lastImageEmbed = `![[${path}]]`;
      await bubble.finish(`「${concept}」配图：\n\n${this.lastImageEmbed}`);
      this.persistDraft();
      return this.lastImageEmbed;
    } catch (e) {
      bubble.remove();
      if (!(e instanceof CancelledError)) this.addBubble("assistant", "配图失败：" + errMsg(e));
      return null;
    } finally {
      this.release();
    }
  }

  private async doSaveNote(): Promise<void> {
    if (!this.history.length) {
      new Notice("还没有对话可保存");
      return;
    }
    const currentSignature = this.stateSignature();
    if (this.lastSavedNote?.stateSignature === currentSignature) {
      this.savedNotice("这段对话和当前产物已保存过：", this.lastSavedNote.path);
      return;
    }
    if (this.lastSavedNote) new Notice("对话或产物已变化，将保存新版本");

    // 先冻结本次保存要用的材料。弹窗期间用户继续聊天，也不会悄悄混进这篇笔记。
    const historySnapshot = this.history.map(m => ({ ...m }));
    const sourcesSnapshot = [...this.sources].sort();
    const mermaidSnapshot = this.lastMermaid;
    const summarySnapshot = this.earlierSummaryFor(SUMMARY_HISTORY_LIMIT);
    let imageSnapshot = this.lastImageEmbed;

    if (!this.acquire()) return;
    let title = "", body = "";
    const t = timedNotice("整理成笔记中…");
    try {
      ({ title, body } = await this.runCancellable(this.plugin.tutor.summarizeNote(historySnapshot, {
        signal: this.currentSignal(),
        earlierSummary: summarySnapshot,
      })));
    } catch (e) {
      if (!(e instanceof CancelledError)) new Notice("整理失败：" + errMsg(e));
      t.stop();
      this.release();
      return;
    }
    t.stop();
    this.release(); // 下面要弹选项框、可能还要长时出图，期间不锁面板

    // 保存选项：标题可就地编辑（LLM 起的不满意别让用户存完改文件名）+ 附提问 + 配图。取消则中止。
    const opts = await askSaveOptions(this.app, title, {
      append: this.plugin.settings.appendConversation,
      hasImage: false, // 始终显示配图复选框，不自动带入
    });
    if (!opts) return; // 取消，不落盘
    const finalTitle = opts.title; // modal 已兜底非空
    if (opts.image && !imageSnapshot) {
      imageSnapshot = await this.runImageFromConcept(finalTitle); // 自行管理 acquire/release
    }

    // 落盘
    if (!this.acquire()) return;
    try {
      // 只附用户的提问（原始问题），不含 AI 回答
      const conversation = opts.append
        ? historySnapshot.filter(m => m.role === "user").map(m => `**你**：${m.content}`).join("\n\n")
        : null;
      const path = await saveNote(this.app, this.plugin.settings, {
        title: finalTitle,
        body,
        sources: sourcesSnapshot,
        mermaid: mermaidSnapshot,
        imageEmbed: opts.image ? imageSnapshot : null, // 只有勾选才加配图
        conversation,
      });
      this.savedNotice("已保存：", path);
      this.addSavedNoteLine(path);
      // 状态消费抽成纯函数 consumeSavedSnapshot（含签名口径不变量说明），便于单测去重逻辑。
      const consumed = consumeSavedSnapshot(
        { lastMermaid: this.lastMermaid, lastImageEmbed: this.lastImageEmbed },
        { history: historySnapshot, sources: sourcesSnapshot, mermaid: mermaidSnapshot, imageEmbed: imageSnapshot },
        path,
        Date.now(),
      );
      this.lastMermaid = consumed.lastMermaid;
      this.lastImageEmbed = consumed.lastImageEmbed;
      for (const s of consumed.consumedSources) this.sources.delete(s);
      this.lastSavedNote = consumed.lastSavedNote;
      this.persistDraft();
    } catch (e) {
      new Notice("保存失败：" + errMsg(e));
    } finally {
      this.release();
    }
  }

  private async doClearDraft(): Promise<void> {
    if (!this.history.length) {
      new Notice("当前没有对话草稿");
      return;
    }
    const confirmed = await askConfirm(this.app, "清空当前对话", "会删除这个面板的消息和草稿，不会删除已经保存的笔记。", "清空");
    if (!confirmed) return;
    this.history = [];
    this.sources.clear();
    this.lastMermaid = null;
    this.lastImageEmbed = null;
    this.lastSavedNote = null;
    this.contextSummary = null;
    this.summaryGen++; // 在途的后台摘要作废，别把旧对话的摘要写回清空后的面板
    this.pendingSourceContexts = [];
    this.inputEl.value = "";
    this.autoGrow();
    this.plugin.clearChatDraft(this.instanceId);
    this.resetConversationUi();
    new Notice("当前对话已清空");
  }

  async onClose(): Promise<void> {
    // 面板已关：在途的后台摘要作废（其 persistDraft 会以关闭时的旧状态覆盖新面板的草稿）
    this.summaryGen++;
    // 关闭即把当前草稿落盘：saveChatDraft 走防抖，关闭时强制冲一次，避免丢最后改动
    this.plugin.flushDrafts();
    this.contentEl.empty();
    // 释放实例 ID，允许再次使用这个槽位
    this.plugin.releaseViewId(this.instanceId);
  }
}
