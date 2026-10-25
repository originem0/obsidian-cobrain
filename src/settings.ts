import { App, PluginSettingTab, Setting, Notice, DropdownComponent, Platform } from "obsidian";
import { classifyModels, detectEmbeddingModels, listModels, testChat } from "./llm/probe";
import { ensureCurrentOption } from "./llm/modelClassifier";
import type CobrainPlugin from "./main";
import { fnv1a } from "./util/hash";

export interface CobrainSettings {
  llmBaseUrl: string;
  llmKey: string;
  llmModel: string;
  embedBaseUrl: string;
  embedKey: string;
  embedModel: string;
  noteFolder: string;
  indexEnabled: boolean;
  indexIncludeFolders: string;
  contextBudgetTokens: number;
  indexExcludeFolders: string; // 逗号/换行分隔，重建和自动索引时跳过
  retrievalMinScore: number;   // 检索命中最低相似度，低于此值不展示、不喂模型
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
// 任务路由只写在这里（不再写进 tutor.ts 的运行时规则）：路由是策略、归用户可编辑的人设管；
// 运行时规则只放不变量，避免用户自定义人设被硬编码规则拆台。
export const DEFAULT_TUTOR_PROMPT = `你是用户的思考伙伴。围绕他明确选择的文档和问题，帮助他解释概念、检验前提、推敲论证、形成自己的判断。
- 用户提问时直接推进问题；需要澄清时只问最关键的一个问题。
- 用户要求解释、总结、改写或列方案时，直接完成，不强行追问。
- 文档可能来自别人、摘录或 AI 整理。区分原作者的观点、用户明确表达的判断，以及你提出的解释和假设。不从文件归属推断思想归属。
- 只讨论当前会话明确附加的材料。材料没有涵盖的部分，说明依据不足，不假装读过全文或检索过其它笔记。
- 引用材料时使用给出的来源链接，具体回应其论点，不逐条罗列。
- 不讨好，不替用户补圆立场；有反例或关键盲点时直接指出。
- 中文回答，简洁自然。观点成形时可以提示保存，避免每轮催促。`;

// 只管语义（选哪些概念、关系怎么标、暴露缺口）；格式硬约束在 tutor.ts 的 mermaidRules 里，
// 方向/节点数也由 conceptMapDirection / conceptMapDetail 注入——用户随便改这段都破坏不了渲染。
const DEFAULT_CONCEPT_MAP_PROMPT = `把这段对话画成一张概念图：顶部一个焦点问题节点，往下是承重概念与它们的关系。
- 只画对话里真正承重的概念，不是提及过的所有名词。
- 关系标签要说清「怎么相关」：导致、依赖、矛盾、是前提；禁用「相关」「联系」这类空词。
- 暴露缺口：对话中尚未解决的连接、缺失的中间概念也要画出来，这类节点或关系标签以「？」结尾——概念图的价值在暴露断层，不在美化已知。`;

const DEFAULT_NOTE_PROMPT = `你即将把这段对话蒸馏成一张 Obsidian 笔记。你是蒸馏器，不是归档员。目标是让笔记成为下次思考的入口，而不是这次对话的存档。

第一行必须用 \`标题：xxx\` 给出具体可检索的标题（「XX 的核心张力」优于「今日对话」）。不要输出 frontmatter；插件保存时会写入 tags、date、status: seedling。

**笔记声音属于用户，不属于 AI**
用户明确认可的判断可用第一人称。外部文档的观点保留作者归属；副脑提出但未经用户确认的解释写成待验证的假设，不能冒充用户已有立场。记录思考轨迹，不替用户补立场。

---

**一、只留三类内容**
- 真正想通的部分 → 一句话概括
- 还没想通的部分 → 转为 \`> [!question]\` 留白，供下次继续想
- 触碰到更深层问题的节点 → 保留，注明「待展开」

铺垫、重复、客套全部丢弃。不替用户把结论说圆。

**二、问题比结论更重要**
开放问题用 \`> [!question]\` callout，让用户下次打开时能继续往深里走。笔记是思考入口，不是答案存档。

**三、接地，用 wikilink**
把对话中已经明确出现的已有概念用 wikilink 引用。只连已确认相关的旧笔记，不凭空造链。

**四、结构跟内容走，不套模板**
- 围绕一个核心概念 → 原子笔记（一概念一张卡）
- 梳理了一段思路 → 框架笔记
- 触发多个发散念头 → MOC 种子（只列标题 + 一句问题，不展开）

---

**格式：**
Markdown 格式，简洁，不写套话，不写流水账。正文 150-400 字为常态（MOC 种子更短），宁短勿水——蒸馏器有容量上限。层级不超过三级。不要输出 \`## 相关\` 区块，插件会用真实来源统一追加。`;

const DEFAULT_INDEX_EXCLUDE_FOLDERS = "Templates, 模板, Archive, 归档";
const LEGACY_DEFAULT_INDEX_EXCLUDE_FOLDERS = "cobrain-note, Templates, 模板, Archive, 归档";

export const DEFAULT_SETTINGS: CobrainSettings = {
  llmBaseUrl: "",
  llmKey: "",
  llmModel: "",
  embedBaseUrl: "",
  embedKey: "",
  embedModel: "",
  noteFolder: "cobrain-note",
  indexEnabled: false,
  indexIncludeFolders: "",
  contextBudgetTokens: 24000,
  indexExcludeFolders: DEFAULT_INDEX_EXCLUDE_FOLDERS,
  retrievalMinScore: 0.3,
  noteTags: "cobrain-note",
  appendConversation: false,
  conceptMapDirection: "TD",
  conceptMapDetail: "中",
  tutorPrompt: DEFAULT_TUTOR_PROMPT,
  conceptMapPrompt: DEFAULT_CONCEPT_MAP_PROMPT,
  notePrompt: DEFAULT_NOTE_PROMPT,
};

type SettingsData = { settings?: unknown; index?: unknown } | Record<string, unknown> | null | undefined;

export function normalizeSettingsData(data: SettingsData): { settings: CobrainSettings; legacyIndex?: unknown } {
  const source =
    data && typeof data === "object" && "settings" in data && data.settings && typeof data.settings === "object"
      ? data.settings as Record<string, unknown>
      : (data && typeof data === "object" ? data as Record<string, unknown> : {});
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof CobrainSettings>) {
    const value = source[key];
    if (typeof DEFAULT_SETTINGS[key] === "number") {
      if (typeof value === "number" && Number.isFinite(value)) (settings[key] as number) = value;
      continue;
    }
    if (typeof DEFAULT_SETTINGS[key] === "boolean") {
      if (typeof value === "boolean") (settings[key] as boolean) = value;
      continue;
    }
    if (typeof value === "string") (settings[key] as string) = value;
  }
  // 仅迁移旧版原样默认提示词；用户修改过的内容原样保留，来源边界由运行规则兜底。
  if (fnv1a(settings.tutorPrompt) === "e8d8133a") settings.tutorPrompt = DEFAULT_TUTOR_PROMPT;
  if (fnv1a(settings.notePrompt) === "ad7b61ea") settings.notePrompt = DEFAULT_SETTINGS.notePrompt;
  settings.contextBudgetTokens = Math.round(Math.min(128000, Math.max(4096, settings.contextBudgetTokens)));
  settings.retrievalMinScore = Math.min(1, Math.max(0, settings.retrievalMinScore));
  if (settings.indexExcludeFolders.trim() === LEGACY_DEFAULT_INDEX_EXCLUDE_FOLDERS) {
    settings.indexExcludeFolders = DEFAULT_INDEX_EXCLUDE_FOLDERS;
  }
  const legacyIndex = data && typeof data === "object" && "index" in data ? data.index : undefined;
  return { settings, legacyIndex };
}

// 只允许把值为 string 的设置键传给文本/文本域助手，避免把 boolean 键喂进去
type StringKeys = { [K in keyof CobrainSettings]: CobrainSettings[K] extends string ? K : never }[keyof CobrainSettings];
type EndpointKind = "chat" | "embed";
type EndpointStatus = { state: "untested" | "ok" | "fail"; text?: string };
// 各端点对应的 model 设置键,供就地刷新下拉时回查当前值
const MODEL_KEY: Record<EndpointKind, StringKeys> = { chat: "llmModel", embed: "embedModel" };

export class CobrainSettingTab extends PluginSettingTab {
  private detected: { chat: string[]; embed: { id: string; dim: number }[] } = {
    chat: [],
    embed: [],
  };
  private status: Record<EndpointKind, EndpointStatus> = {
    chat: { state: "untested" },
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
    const retrieval = this.collapsible(containerEl, "可选资料检索", false).body;
    this.renderEndpointSection(retrieval, {
      title: "嵌入 API（手动检索时使用）",
      kind: "embed",
      urlKey: "embedBaseUrl",
      keyKey: "embedKey",
      modelKey: "embedModel",
    });

    const advanced = this.collapsible(containerEl, "高级设置", false).body;
    this.renderConversationSection(advanced);
    this.renderConceptMapSection(advanced);
    this.renderIndexSection(advanced);
    this.renderNoteSection(containerEl);
    this.renderPromptSection(containerEl);
  }

  private renderEndpointSection(
    container: HTMLElement,
    opts: { title: string; kind: EndpointKind; urlKey: StringKeys; keyKey: StringKeys; modelKey: StringKeys },
  ): void {
    const s = this.plugin.settings;
    const { body, status } = this.collapsible(container, opts.title, opts.kind === "chat");
    this.statusEls[opts.kind] = status;
    this.paintStatus(status, this.status[opts.kind]);

    if (opts.kind === "embed") {
      const warn = body.createEl("p", {
        text: "隐私提示：建立索引会把你的笔记全文分块发送到这个嵌入端点。请显式配置你信任的端点。",
      });
      warn.setCssStyles({
        fontSize: "0.85em", margin: "4px 0 10px", padding: "6px 10px", lineHeight: "1.5",
        borderLeft: "3px solid var(--text-error)", background: "var(--background-secondary)", borderRadius: "4px",
      });
    }

    if (opts.kind !== "chat") {
      // 多数用户文本和嵌入端点相同：一键复用文本端点的 URL/Key，砍掉重复粘贴（模型仍需单独检测选择）
      new Setting(body)
        .setName("复用文本端点")
        .setDesc("把文本 LLM 的 Base URL 和 API Key 复制过来，模型仍需单独「检测」选择")
        .addButton(b =>
          b.setButtonText("复制过来").onClick(() => {
            if (!s.llmBaseUrl && !s.llmKey) {
              new Notice("文本 LLM 端点还没配置");
              return;
            }
            (s[opts.urlKey] as string) = s.llmBaseUrl;
            (s[opts.keyKey] as string) = s.llmKey;
            this.status[opts.kind] = { state: "untested" };
            // 端点已换，旧检测列表作废
            if (opts.kind === "embed") this.detected.embed = [];
            this.plugin.saveSettingsDebounced();
            new Notice("已复制文本端点的 URL 和 Key");
            this.display(); // 整页重绘刷新输入框显示值（显式按钮操作，失焦可接受）
          }),
        );
    }

    this.text(body, "Base URL", "OpenAI 兼容端点", opts.urlKey, "", opts.kind);
    this.secretText(body, "API Key", "仅存本地，不入库", opts.keyKey, "sk-...", opts.kind);

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
          const oldText = b.buttonEl.textContent || "检测";
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
            const msg = e instanceof Error ? e.message : String(e);
            new Notice("检测失败：" + msg);
          } finally {
            b.setButtonText(oldText).setDisabled(false);
            this.paintStatus(this.statusEls[opts.kind]!, this.status[opts.kind]);
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
            await this.plugin.resetIndexForEmbedModelChange();
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
            const oldText = b.buttonEl.textContent || "测试";
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
            } finally {
              b.setButtonText(oldText).setDisabled(false);
              this.paintStatus(this.statusEls.chat!, this.status.chat);
            }
          }),
        );
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

  private renderConversationSection(container: HTMLElement): void {
    const { body } = this.collapsible(container, "长对话", false);
    new Setting(body).setName("对话输入预算").setDesc("按文本长度保守估算 token；请低于模型的上下文容量，并留出回答空间。超出预算时先整理旧消息，完整记录始终保留。")
      .addText(t => {
        t.inputEl.type = "number";
        t.inputEl.min = "4096";
        t.inputEl.max = "128000";
        t.setValue(String(this.plugin.settings.contextBudgetTokens)).onChange(value => {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 4096 && n <= 128000) {
            this.plugin.settings.contextBudgetTokens = Math.round(n);
            this.plugin.saveSettingsDebounced();
          }
        });
      });
  }

  private renderIndexSection(container: HTMLElement): void {
    const s = this.plugin.settings;
    const { body } = this.collapsible(container, "索引范围与诊断", false);
    body.createEl("p", { text: "普通文档对话不需要索引。只在手动检索其它资料时使用；未列入允许目录的笔记不会建立索引，也不会出现在检索结果中。" });
    new Setting(body).setName("启用可选索引").addToggle(t => t.setValue(s.indexEnabled).onChange(async value => {
      s.indexEnabled = value;
      await this.plugin.indexScopeChanged().catch(e => this.plugin.reportError(e));
    }));
    const scopeInput = (name: string, key: "indexIncludeFolders" | "indexExcludeFolders", desc: string) => {
      new Setting(body).setName(name).setDesc(desc).addTextArea(t => {
        t.setValue(s[key]).onChange(value => { s[key] = value; this.plugin.saveSettingsDebounced(); });
        // 输入目录名的中间状态不能立刻删除现有索引；失焦后再清理，检索本身始终按最新设置过滤。
        t.inputEl.addEventListener("blur", () => void this.plugin.indexScopeChanged().catch(e => this.plugin.reportError(e)));
      });
    };
    scopeInput("允许索引的目录", "indexIncludeFolders", "逗号或换行分隔。留空不索引任何笔记；填写一个点表示允许整个库，再应用排除目录。");
    scopeInput("排除目录", "indexExcludeFolders", "逗号或换行分隔，优先于允许目录；隐藏目录始终跳过。");
    new Setting(body).setName("检索最低分").addSlider(slider => {
      slider.setLimits(0, 1, 0.01).setValue(s.retrievalMinScore).setDynamicTooltip().onChange(value => {
        s.retrievalMinScore = value; this.plugin.saveSettingsDebounced();
      });
    });
    new Setting(body).setName("索引维护")
      .addButton(b => b.setButtonText("重建允许范围").onClick(() => void this.plugin.rebuildIndex().catch(e => this.plugin.reportError(e))))
      .addButton(b => b.setButtonText("查看状态").onClick(() => void this.plugin.showIndexStatus().catch(e => this.plugin.reportError(e))))
      .addButton(b => b.setButtonText("测试检索").onClick(() => this.plugin.openRetrievalTest()));
  }

  private renderNoteSection(container: HTMLElement): void {
    const s = this.plugin.settings;
    const { body } = this.collapsible(container, "笔记", false);

    this.text(body, "笔记目录", "存为笔记的目标目录", "noteFolder");
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
      text: "提示词直接决定对话和笔记质量；这里的内容会覆盖代码默认值。若你保存过旧提示词，点「恢复默认」切到新版。",
    });
    note.setCssStyles({ fontSize: "0.85em", color: "var(--text-muted)", margin: "4px 0 12px", lineHeight: "1.5" });
    this.promptTextArea(body, "副脑人设", "对话时的系统提示词", "tutorPrompt", DEFAULT_TUTOR_PROMPT);
    this.promptTextArea(body, "概念图", "生成 Mermaid 概念图的提示词（方向/详细度由上方设置注入）", "conceptMapPrompt", DEFAULT_CONCEPT_MAP_PROMPT);
    this.promptTextArea(body, "笔记综述", "把对话整理成笔记的提示词", "notePrompt", DEFAULT_NOTE_PROMPT);
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

  // API Key 输入：密码态显示 + 眼睛按钮切换。设置页截屏/共享屏幕时不再裸奔明文密钥。
  private secretText(parent: HTMLElement, name: string, desc: string, key: StringKeys, ph = "", resetStatus?: EndpointKind): void {
    const s = this.plugin.settings;
    let inputEl: HTMLInputElement | null = null;
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addText(t => {
        inputEl = t.inputEl;
        t.inputEl.type = "password";
        t.setPlaceholder(ph).setValue(s[key]).onChange(v => {
          s[key] = v.trim();
          if (resetStatus) {
            this.status[resetStatus] = { state: "untested" };
            if (resetStatus === "embed") this.detected.embed = [];
            else this.detected[resetStatus] = [];
            const el = this.statusEls[resetStatus];
            if (el) this.paintStatus(el, this.status[resetStatus]);
            this.refreshModelDropdown(resetStatus);
          }
          this.plugin.saveSettingsDebounced();
        });
      })
      .addExtraButton(b =>
        b.setIcon("eye").setTooltip("显示 / 隐藏").onClick(() => {
          if (!inputEl) return;
          inputEl.type = inputEl.type === "password" ? "text" : "password";
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

  private promptTextArea(parent: HTMLElement, name: string, desc: string, key: StringKeys, defaultValue: string): void {
    const s = this.plugin.settings;
    let setValue: ((v: string) => void) | null = null;
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addTextArea(t => {
        setValue = (v: string) => t.setValue(v);
        t.setValue(s[key]).onChange(v => {
          s[key] = v;
          this.plugin.saveSettingsDebounced();
        });
        // 人设提示词动辄几百字，6 行的编辑窗口是在惩罚认真调提示词的用户
        t.inputEl.rows = 14;
        t.inputEl.setCssStyles({ width: "100%", resize: "vertical" });
      })
      .addButton(b =>
        b.setButtonText("恢复默认").onClick(async () => {
          s[key] = defaultValue;
          setValue?.(defaultValue);
          await this.plugin.saveSettings();
          new Notice(`${name}已恢复默认`);
        }),
      );
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
