import { App, PluginSettingTab, Setting, Notice, DropdownComponent, Platform } from "obsidian";
import { classifyModels, detectEmbeddingModels, listModels, testChat } from "./llm/probe";
import { ensureCurrentOption } from "./llm/modelClassifier";
import type CobrainPlugin from "./main";

export interface CobrainSettings {
  llmBaseUrl: string;
  llmKey: string;
  llmModel: string;
  imageBaseUrl: string;
  imageKey: string;
  imageModel: string;
  imageStyle: string;       // 配图风格预设，拼接到出图提示词尾部
  imageQuality: string;     // 质量档位；空=不发送该参数（兼容不支持的代理）
  imageSize: string;        // 出图尺寸
  embedBaseUrl: string;
  embedKey: string;
  embedModel: string;
  noteFolder: string;
  attachmentFolder: string;
  noteTags: string;             // 逗号分隔，写入笔记 frontmatter tags
  appendConversation: boolean;  // 存笔记时是否附上你的提问（原始问题，不含 AI 回答）
  conceptMapDirection: string;  // Mermaid 方向：TD / LR
  conceptMapDetail: string;     // 概念图详细度：简 / 中 / 详
  tutorPrompt: string;          // 导师系统提示词
  conceptMapPrompt: string;     // 概念图系统提示词（方向/详细度另行注入）
  notePrompt: string;           // 笔记综述系统提示词
}

// 提示词默认值即原硬编码文案，移到设置后用户可改（设计文档第 8 条「提示词可定制」）
// 人设是「助产士」而非「讲解员」：基于用户自己的笔记回抛问题、逼他自己想，而不是灌输。
const DEFAULT_TUTOR_PROMPT = `你是用户的「思考助产士」，不是讲解员。你提供流动性与方向感；真正的理解，必须由用户自己从卡顿中逼出来。

---

**一、笔记是起点，不是答案**
「已有笔记」代表用户写过什么，不等于他真正理解了什么。先定位他的已知边界；引用时只用插件本轮检索并列出的笔记，以 [[笔记名]] 标出，并主动把它推到眼前：「你之前在 [[某笔记]] 里写过这个——它和你现在想的矛盾吗？去撞一撞。」不要引用检索范围之外的笔记，那是 AI 的联想，不是用户的联想。同时检查旧笔记有无盲点、概念偷换、未经检验的预设——发现即指出，不必迁就。

**二、先问后讲**
每次回应，先抛问题，再决定是否补充解释。三种问法：
- **差异性发问**——「A 和 B 在这一点上，为何走向不同？」
- **辩证逆转**——把用户的障碍翻转为条件：「会不会正是这个困扰，才让那件事得以成立？」
- **解构前提**——把隐含假设翻出来逼他检验：「你这个说法有个前提——它真的成立吗？」

问题的目标不只是收集信息，而是帮他找到「基本问题」——那个驱动所有表面困惑、藏在更深处的根本。避免「你怎么理解 X？」这类无摩擦力的开放泛问。

**三、克制出手**
不主动给完整解释。只有两种情况出手：用户明显卡住，或明确要求解释。出手时先骨架后细节，够用即止。同时留意抽象层：若用户卡在抽象语言里，逼他给一个具体例子；若他陷在具体细节里，逼他抽出背后的原则。说一半比说完整更有价值。

**四、不讨好，不补白**
不评价用户「很精准」「很坦诚」「抓到核心」。说得稳，直接推进；说得不稳，直接指出哪里不稳。不替用户把话说圆、把感受说满——他还没说出口的，正是他需要去想的。

---
中文回答，简洁有重点；类比优先找结构同构的意象（不求精确定义，求模式相似），可用 Markdown。`;

// 注意：不写死 graph 方向（由 conceptMapDirection 注入），也不写死节点数（由 conceptMapDetail 注入）
const DEFAULT_CONCEPT_MAP_PROMPT =
  "只输出一个 ```mermaid 代码块，不要任何其它文字。顶部一个焦点问题节点，往下是核心概念，用带中文标签的箭头表示概念间关系。节点文字用中文，简短。";

const DEFAULT_NOTE_PROMPT = `你即将把这段对话蒸馏成一张 Obsidian 笔记。你是蒸馏器，不是归档员。目标是让笔记成为下次思考的入口，而不是这次对话的存档。

第一行必须用 \`标题：xxx\` 给出具体可检索的标题（「XX 的核心张力」优于「今日对话」）。不要输出 frontmatter；插件保存时会写入 tags、date、status: seedling。

**笔记声音属于用户，不属于 AI**
用第一人称或中性视角写，不写「用户认为……」「AI 提出……」。记录思考轨迹，不记录对话过程。

---

**一、只留三类内容**
- 真正想通的部分 → 一句话概括
- 还没想通的部分 → 转为 \`> [!question]\` 留白，供下次继续想
- 触碰到更深层问题的节点 → 保留，注明「待展开」

铺垫、重复、客套全部丢弃。不替用户把结论说圆。

**二、问题比结论更重要**
开放问题用 \`> [!question]\` callout，让用户下次打开时能继续往深里走。笔记是思考入口，不是答案存档。

**三、接地，用 wikilink**
把对话中真正触及的已有概念用 \`[[笔记名]]\` 引用。只连已确认相关的旧笔记，不凭空造链。

**四、结构跟内容走，不套模板**
- 围绕一个核心概念 → 原子笔记（一概念一张卡）
- 梳理了一段思路 → 框架笔记
- 触发多个发散念头 → MOC 种子（只列标题 + 一句问题，不展开）

---

**格式：**
Markdown 格式，简洁，不写套话，不写流水账。层级不超过三级，末尾设 \`## 相关\` 区块列 wikilink。`;

export const DEFAULT_SETTINGS: CobrainSettings = {
  llmBaseUrl: "https://wududu.edu.kg/v1",
  llmKey: "",
  llmModel: "z-ai/glm-5.1",
  imageBaseUrl: "https://freeapi.dgbmc.top/v1",
  imageKey: "",
  imageModel: "gpt-image-2",
  imageStyle: "现代扁平矢量教学插画，简洁有冲击力的构图，高对比柔和配色，主体居中，适度留白",
  imageQuality: "",
  imageSize: "1024x1024",
  embedBaseUrl: "https://router.tumuer.me/v1",
  embedKey: "",
  embedModel: "BAAI/bge-m3",
  noteFolder: "cobrain-note",
  attachmentFolder: "cobrain-note/附件",
  noteTags: "cobrain-note",
  appendConversation: false,
  conceptMapDirection: "TD",
  conceptMapDetail: "中",
  tutorPrompt: DEFAULT_TUTOR_PROMPT,
  conceptMapPrompt: DEFAULT_CONCEPT_MAP_PROMPT,
  notePrompt: DEFAULT_NOTE_PROMPT,
};

// 只允许把值为 string 的设置键传给文本/文本域助手，避免把 boolean 键喂进去
type StringKeys = { [K in keyof CobrainSettings]: CobrainSettings[K] extends string ? K : never }[keyof CobrainSettings];
type EndpointKind = "chat" | "image" | "embed";
type EndpointStatus = { state: "untested" | "ok" | "fail"; text?: string };
// 各端点对应的 model 设置键,供就地刷新下拉时回查当前值
const MODEL_KEY: Record<EndpointKind, StringKeys> = { chat: "llmModel", image: "imageModel", embed: "embedModel" };

export class CobrainSettingTab extends PluginSettingTab {
  private detected: { chat: string[]; image: string[]; embed: { id: string; dim: number }[] } = {
    chat: [],
    image: [],
    embed: [],
  };
  private status: Record<EndpointKind, EndpointStatus> = {
    chat: { state: "untested" },
    image: { state: "untested" },
    embed: { state: "untested" },
  };
  // 状态灯 / 模型下拉的元素引用,用于改 URL/Key 后就地刷新而不整页重绘(整页重绘会让输入框失焦)
  private statusEls: Partial<Record<EndpointKind, HTMLElement>> = {};
  private modelDropdowns: Partial<Record<EndpointKind, DropdownComponent>> = {};

  constructor(app: App, private plugin: CobrainPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.setCssStyles({ paddingBottom: "24px" });

    this.renderEndpointSection(containerEl, {
      title: "文本 LLM（对话）",
      kind: "chat",
      urlKey: "llmBaseUrl",
      keyKey: "llmKey",
      modelKey: "llmModel",
    });
    this.renderEndpointSection(containerEl, {
      title: "图像",
      kind: "image",
      urlKey: "imageBaseUrl",
      keyKey: "imageKey",
      modelKey: "imageModel",
    });
    this.renderEndpointSection(containerEl, {
      title: "嵌入 API（语义检索）",
      kind: "embed",
      urlKey: "embedBaseUrl",
      keyKey: "embedKey",
      modelKey: "embedModel",
    });

    this.renderConceptMapSection(containerEl);
    this.renderNoteSection(containerEl);
    this.renderPromptSection(containerEl);
  }

  private renderEndpointSection(
    container: HTMLElement,
    opts: { title: string; kind: EndpointKind; urlKey: StringKeys; keyKey: StringKeys; modelKey: StringKeys },
  ): void {
    const s = this.plugin.settings;
    const { body, status } = this.collapsible(container, opts.title, true);
    this.statusEls[opts.kind] = status;
    this.paintStatus(status, this.status[opts.kind]);

    if (opts.kind === "embed") {
      const warn = body.createEl("p", {
        text: "隐私提示：建立索引会把你的笔记全文分块发送到这个嵌入端点。请使用你信任的端点；默认免费代理只适合试用。",
      });
      warn.setCssStyles({
        fontSize: "0.85em", margin: "4px 0 10px", padding: "6px 10px", lineHeight: "1.5",
        borderLeft: "3px solid var(--text-error)", background: "var(--background-secondary)", borderRadius: "4px",
      });
    }

    this.text(body, "Base URL", "OpenAI 兼容端点", opts.urlKey, "", opts.kind);
    this.text(body, "API Key", "仅存本地，不入库", opts.keyKey, "sk-...", opts.kind);

    const detectedOptions = this.modelOptions(opts.kind, s[opts.modelKey]);
    new Setting(body)
      .setName("Model")
      .setDesc(this.modelDesc(opts.kind, detectedOptions.length))
      .addButton(b =>
        b.setButtonText("检测").onClick(async () => {
          if (!s[opts.urlKey] || !s[opts.keyKey]) {
            new Notice("请先填 Base URL 和 API Key");
            return;
          }
          b.setButtonText("检测中…").setDisabled(true);
          const notice = new Notice(opts.kind === "embed" ? "正在逐个测试嵌入模型…" : "正在拉取模型列表…", 0);
          try {
            if (opts.kind === "embed") {
              this.detected.embed = await detectEmbeddingModels(s[opts.urlKey], s[opts.keyKey]);
              this.status.embed = this.detected.embed.length
                ? { state: "ok", text: `已连通 · ${this.detected.embed.length} 个` }
                : { state: "fail", text: "没有可用嵌入模型" };
              new Notice(this.detected.embed.length ? `检测到 ${this.detected.embed.length} 个可用嵌入模型` : "没检测到可用的嵌入模型");
            } else {
              const ids = await listModels(s[opts.urlKey], s[opts.keyKey]);
              if (!ids.length) throw new Error("模型列表为空");
              const groups = classifyModels(ids);
              const picked = groups[opts.kind];
              this.detected[opts.kind] = picked.length ? picked : ids;
              this.status[opts.kind] = { state: "untested", text: `已列出 ${this.detected[opts.kind].length} 个，未测试` };
              new Notice(
                picked.length
                  ? `已列出 ${picked.length} 个候选模型`
                  : "未识别出该类模型，已列出全部模型供手选",
              );
            }
            notice.hide();
            this.refreshModelDropdown(opts.kind);
          } catch (e) {
            notice.hide();
            this.status[opts.kind] = { state: "fail", text: "检测失败" };
            this.paintStatus(this.statusEls[opts.kind]!, this.status[opts.kind]);
            const msg = e instanceof Error ? e.message : String(e);
            new Notice("检测失败：" + msg);
          }
        }),
      )
      .addDropdown(d => {
        this.modelDropdowns[opts.kind] = d;
        for (const item of detectedOptions) d.addOption(item.value, item.label);
        d.setValue(s[opts.modelKey]).onChange(async v => {
          if (v === s[opts.modelKey]) return;
          // 移动端只读：换嵌入模型会清空索引并要求重建，而移动端无法重建——撤销 UI 选择、不改设置。
          if (opts.kind === "embed" && Platform.isMobile) {
            d.setValue(s[opts.modelKey]);
            new Notice("嵌入模型请在桌面端更换（移动端只读）");
            return;
          }
          s[opts.modelKey] = v;
          this.status[opts.kind] = { state: "untested" };
          if (opts.kind === "embed") {
            await this.plugin.saveSettings();
            // 换模型 → 旧向量维度/空间不兼容，立即清空，待重建
            this.plugin.store.deserialize(null);
            await this.plugin.indexStore.clearAll();
            new Notice(`已切到 ${v}，索引已清空，请运行「Cobrain: 重建索引」`);
          } else {
            this.plugin.saveSettingsDebounced();
          }
        });
      });

    if (opts.kind === "chat") {
      new Setting(body)
        .setName("可用性")
        .setDesc("发送一次极短消息，验证该模型是否真能调用")
        .addButton(b =>
          b.setButtonText("测试").onClick(async () => {
            if (!s[opts.urlKey] || !s[opts.keyKey] || !s[opts.modelKey]) {
              new Notice("请先填 Base URL、API Key 和 Model");
              return;
            }
            b.setButtonText("测试中…").setDisabled(true);
            try {
              const r = await testChat(s[opts.urlKey], s[opts.keyKey], s[opts.modelKey]);
              this.status.chat = r.ok
                ? { state: "ok", text: `已连通 · ${r.ms}ms` }
                : { state: "fail", text: r.error ?? "测试失败" };
              new Notice(r.ok ? `聊天模型可用（${r.ms}ms）` : `聊天模型不可用：${r.error ?? "未知错误"}`);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              this.status.chat = { state: "fail", text: msg };
              new Notice("测试失败：" + msg);
            }
            this.paintStatus(this.statusEls.chat!, this.status.chat);
          }),
        );
    }

    if (opts.kind === "image") {
      const note = body.createEl("p", { text: "图像模型不自动测试。出图耗时长且可能计费，请用「配图」功能实测。" });
      note.setCssStyles({ fontSize: "0.85em", color: "var(--text-muted)", margin: "6px 0 14px" });
      this.text(body, "尺寸", "如 1024x1024", "imageSize");
      this.text(body, "质量", "如 high/medium/low 或 hd；留空则不发送（部分代理不支持此参数）", "imageQuality");
      this.textArea(body, "风格预设", "拼到每张配图提示词尾部，统一画风", "imageStyle");
    }
  }

  private renderConceptMapSection(container: HTMLElement): void {
    const s = this.plugin.settings;
    const { body } = this.collapsible(container, "概念图", false);

    new Setting(body)
      .setName("方向")
      .setDesc("Mermaid 布局方向")
      .addDropdown(d => {
        d.addOption("TD", "自上而下 (TD)");
        d.addOption("LR", "自左向右 (LR)");
        d.setValue(s.conceptMapDirection).onChange(async v => {
          s.conceptMapDirection = v;
          await this.plugin.saveSettings();
        });
      });
    new Setting(body)
      .setName("详细度")
      .setDesc("概念图的节点密度")
      .addDropdown(d => {
        d.addOption("简", "简（核心 5-7 节点）");
        d.addOption("中", "中（10 节点左右）");
        d.addOption("详", "详（15+ 节点，含次级关系）");
        d.setValue(s.conceptMapDetail).onChange(async v => {
          s.conceptMapDetail = v;
          await this.plugin.saveSettings();
        });
      });
  }

  private renderNoteSection(container: HTMLElement): void {
    const s = this.plugin.settings;
    const { body } = this.collapsible(container, "笔记", false);

    this.text(body, "笔记目录", "存为笔记的目标目录", "noteFolder");
    this.text(body, "附件目录", "配图保存目录", "attachmentFolder");
    this.text(body, "标签", "逗号分隔，写入 frontmatter tags", "noteTags");
    new Setting(body)
      .setName("附原始问题")
      .setDesc("存为笔记时该项的默认勾选状态（每次保存仍可在选项框里单独调整）")
      .addToggle(t =>
        t.setValue(s.appendConversation).onChange(async v => {
          s.appendConversation = v;
          this.plugin.saveSettingsDebounced();
        }),
      );
  }

  private renderPromptSection(container: HTMLElement): void {
    const { body } = this.collapsible(container, "提示词（可自定义）", false);
    const note = body.createEl("p", {
      text: "提示词直接决定对话和笔记质量；这里的内容会覆盖代码默认值。默认值在 src/settings.ts，可按自己的思考风格调整。",
    });
    note.setCssStyles({ fontSize: "0.85em", color: "var(--text-muted)", margin: "4px 0 12px", lineHeight: "1.5" });
    this.textArea(body, "副脑人设", "对话时的系统提示词", "tutorPrompt");
    this.textArea(body, "概念图", "生成 Mermaid 概念图的提示词（方向/详细度由上方设置注入）", "conceptMapPrompt");
    this.textArea(body, "笔记综述", "把对话整理成笔记的提示词", "notePrompt");
  }

  private text(parent: HTMLElement, name: string, desc: string, key: StringKeys, ph = "", resetStatus?: EndpointKind): void {
    const s = this.plugin.settings;
    new Setting(parent).setName(name).setDesc(desc).addText(t =>
      t.setPlaceholder(ph).setValue(s[key]).onChange(v => {
        s[key] = v.trim();
        if (resetStatus) {
          this.status[resetStatus] = { state: "untested" };
          if (resetStatus === "embed") this.detected.embed = [];
          else this.detected[resetStatus] = [];
          // 端点已改,之前的检测作废:就地重绘状态灯 + 重建下拉(不整页重绘以免输入框失焦)
          const el = this.statusEls[resetStatus];
          if (el) this.paintStatus(el, this.status[resetStatus]);
          this.refreshModelDropdown(resetStatus);
        }
        this.plugin.saveSettingsDebounced();
      }),
    );
  }

  // 提示词等多行文本：不 trim（保留换行/缩进）
  private textArea(parent: HTMLElement, name: string, desc: string, key: StringKeys): void {
    const s = this.plugin.settings;
    new Setting(parent).setName(name).setDesc(desc).addTextArea(t => {
      t.setValue(s[key]).onChange(v => {
        s[key] = v;
        this.plugin.saveSettingsDebounced();
      });
      t.inputEl.rows = 6;
      t.inputEl.setCssStyles({ width: "100%" });
    });
  }

  private collapsible(
    container: HTMLElement,
    title: string,
    open: boolean,
  ): { body: HTMLElement; status: HTMLElement } {
    const details = container.createEl("details");
    details.open = open;
    details.setCssStyles({
      margin: "0 0 10px", padding: "0", border: "1px solid var(--background-modifier-border)",
      borderRadius: "6px", background: "var(--background-primary)",
    });
    const summary = details.createEl("summary");
    summary.setCssStyles({
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px",
      cursor: "pointer", padding: "10px 12px", fontWeight: "600",
    });
    summary.createSpan({ text: title });
    const status = summary.createSpan();
    status.setCssStyles({ fontSize: "0.82em", fontWeight: "500", color: "var(--text-muted)", whiteSpace: "nowrap" });
    const body = details.createDiv();
    body.setCssStyles({ padding: "0 12px 12px" });
    return { body, status };
  }

  private paintStatus(el: HTMLElement, status: EndpointStatus): void {
    if (status.state === "ok") {
      el.setText(`● ${status.text ?? "已连通"}`);
      el.setCssStyles({ color: "var(--text-success)" });
      return;
    }
    if (status.state === "fail") {
      el.setText(`✗ ${status.text ?? "失败"}`);
      el.setCssStyles({ color: "var(--text-error)" });
      return;
    }
    el.setText(`○ ${status.text ?? "未测"}`);
    el.setCssStyles({ color: "var(--text-muted)" });
  }

  private refreshModelDropdown(kind: EndpointKind): void {
    const d = this.modelDropdowns[kind];
    if (!d) return;
    const current = this.plugin.settings[MODEL_KEY[kind]];
    d.selectEl.empty();
    for (const opt of this.modelOptions(kind, current)) d.addOption(opt.value, opt.label);
    if (current) d.setValue(current);
  }

  private modelOptions(kind: EndpointKind, current: string): { value: string; label: string }[] {
    if (kind === "embed") {
      // current 始终并入,避免检测列表不含已存模型时下拉选不中(显示与实际不符)
      const ids = ensureCurrentOption(this.detected.embed.map(m => m.id), current);
      return ids.filter(Boolean).map(id => {
        const dim = this.detected.embed.find(m => m.id === id)?.dim ?? 0;
        return { value: id, label: dim ? `${id} · ${dim}维` : id };
      });
    }
    const ids = ensureCurrentOption(this.detected[kind], current);
    return ids.filter(Boolean).map(id => ({ value: id, label: id }));
  }

  private modelDesc(kind: EndpointKind, count: number): string {
    if (kind === "embed") {
      return this.detected.embed.length
        ? `已检测到 ${count} 个实际可用嵌入模型`
        : "点「检测」列出并真实试用该端点的嵌入模型";
    }
    if (this.detected[kind].length) return `已检测到 ${count} 个候选模型，下拉选择`;
    return "点「检测」从 /models 拉取候选模型；也可直接保留当前值";
  }
}
