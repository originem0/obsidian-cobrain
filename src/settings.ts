import { App, PluginSettingTab, Setting, Notice, DropdownComponent, Platform } from "obsidian";
import { classifyModels, detectEmbeddingModels, listModels, testChat } from "./llm/probe";
import { ensureCurrentOption } from "./llm/modelClassifier";
import type CobrainPlugin from "./main";
import type { TextComponent } from "obsidian";
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

// 任务策略可由用户修改；材料边界与归属规则在 tutor.ts 中统一追加。
export const DEFAULT_TUTOR_PROMPT = `你是用户的思考伙伴。围绕他明确选择的文档和问题，帮助他解释概念、检验前提、推敲论证、形成自己的判断。
- 先识别本轮要完成的任务。解释就讲清概念和适用条件；总结就保留主张、理由和限制；改写或列方案就直接给出结果。需要澄清时只问影响结果的一个关键问题。
- 检验观点时，先准确复述被检验的主张，再指出最影响结论的证据缺口、隐藏前提或反例，并给出可继续验证的一步。不为反驳而反驳，论据充分时明确说明成立的条件。
- 区分材料原作者的观点、用户明确表达或认可的判断、你提出的解释和假设。追问、沉默、要求改写都不等于认可，不替用户补成立场。
- 材料范围以本轮附加内容为准。使用背景知识时标明它不是材料原文；无法核验的外部事实或案例说明待核验，不编造引文、出处或数字。
- 引用时带上给出的来源链接和支持判断的短句或小节。只收到节选或摘要时说明结论限于这些内容，不把转述伪装成逐字引文。
- 中文回答，先给核心判断，再给必要理由。自然、简洁，结构跟任务走，不固定套模板，不在每轮结尾追问或催促保存。`;

// 语义策略与布局提示分开；提示词只能提高格式遵循率，不能保证 Mermaid 语法有效。
const DEFAULT_CONCEPT_MAP_PROMPT = `把这段对话画成一张概念图：顶部一个焦点问题节点，往下是承重概念与它们的关系。
- 只画支持核心判断或未决问题的概念；材料不足时少画，不为凑节点数补造内容。
- 关系标签写清含义，如依赖、支持、反驳、限制、是前提。仅有相关性时写共同出现，不升级成导致；对话没有依据的连接可以省略。
- 原作者的主张或副脑的假设需要注明归属。未经用户明确认可的关系不能画成用户已确认的结论。
- 对话中明确存在的证据缺口或未决连接以「？」结尾，并写清待验证的内容。不为了显得深刻凭空制造缺口。`;

const DEFAULT_NOTE_PROMPT = `把这段对话整理成一张可继续思考的 Obsidian 笔记，保留判断为什么成立，以及下一步还要解决什么。

第一行用 \`标题：xxx\` 给出具体可检索的标题，其后直接输出 Markdown 正文。不要输出 frontmatter、整篇代码围栏或重复的一级标题。

- 只把用户明确表达或认可的判断写成第一人称。用户的追问、沉默和要求整理不算认可；尚无明确判断时写讨论提出了什么，不代替用户宣布想通了。
- 外部材料的观点保留作者归属。副脑提出但未经确认的解释、方案或结论标为假设或待确认；已被否定的观点记录修正，不能继续写成结论。
- 保留核心问题、关键判断、最必要的理由或例子，以及会改变结论的反证和适用条件。删掉客套与重复，不因压缩而只剩没有依据的口号。
- 对话中确实未解决的问题用 \`> [!question]\` callout，写清缺哪项证据或下一步如何验证。已有明确答案时不硬造开放问题。
- 只复用本轮材料来源中给出的完整 wikilink，或用户明确确认过目标的笔记链接。提到一个概念不代表库里存在同名笔记；不能确认目标时用普通文字。
- 结构跟内容走，不固定套原子笔记、框架或 MOC 模板。正文通常 150-400 字，必要的论据与限制优先于字数。层级不超过三级。
- 不输出 \`## 相关\` 区块，插件会用实际会话来源统一追加。`;

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

export function normalizeSettingsData(data: unknown): { settings: CobrainSettings; legacyIndex?: unknown } {
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
  if (["e8d8133a", "c4920ad1"].includes(fnv1a(settings.tutorPrompt))) settings.tutorPrompt = DEFAULT_TUTOR_PROMPT;
  if (fnv1a(settings.conceptMapPrompt) === "cd4b2fcf") settings.conceptMapPrompt = DEFAULT_CONCEPT_MAP_PROMPT;
  if (["ad7b61ea", "d40ef196"].includes(fnv1a(settings.notePrompt))) settings.notePrompt = DEFAULT_NOTE_PROMPT;
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
  private modelInputs: Partial<Record<EndpointKind, TextComponent>> = {};

  constructor(app: App, private plugin: CobrainPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("cobrain-settings");
    // 设置宿主/主题可能裁切内容或采用 flex；明确让本页滚动，折叠区按自然高度排列。

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
      body.createEl("p", {
        text: "隐私提示：建立索引会把你的笔记全文分块发送到这个嵌入端点。请显式配置你信任的端点。",
        cls: "cobrain-endpoint-warning",
      });
    }

    if (opts.kind !== "chat") {
      // 多数用户文本和嵌入端点相同：一键复用文本端点的 URL/Key，砍掉重复粘贴（模型仍需单独检测选择）
      new Setting(body)
        .setName("复用文本端点")
        .setDesc("复制文本 LLM 的 Base URL 和 API Key；嵌入模型可手填或检测后选择")
        .addButton(b =>
          b.setButtonText("复制过来").onClick(() => {
            if (!s.llmBaseUrl && !s.llmKey) {
              new Notice("文本 LLM 端点还没配置");
              return;
            }
            s[opts.urlKey] = s.llmBaseUrl;
            s[opts.keyKey] = s.llmKey;
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
    this.secretText(body, "API Key", "明文保存在库内插件数据中；同步插件目录时也会同步密钥", opts.keyKey, "sk-...", opts.kind);

    const detectedOptions = this.modelOptions(opts.kind, s[opts.modelKey]);
    new Setting(body)
      .setName("Model")
      .setDesc(this.modelDesc(opts.kind, detectedOptions.length))
      .addText(t => {
        this.modelInputs[opts.kind] = t;
        t.setPlaceholder("手填模型名称").setValue(s[opts.modelKey]);
        t.inputEl.name = `cobrain-${opts.kind}-model`;
        t.inputEl.setAttribute("aria-label", `${opts.kind === "chat" ? "文本" : "嵌入"}模型名称`);
        if (opts.kind === "embed") {
          // 更换嵌入模型会清索引，只在完成编辑时提交，避免每敲一个字就重置。
          t.inputEl.disabled = Platform.isMobile;
          t.inputEl.addEventListener("change", () => {
            void this.changeModel(opts.kind, t.inputEl.value).catch(e => this.plugin.reportError(e));
          });
        } else {
          t.onChange(value => { void this.changeModel(opts.kind, value).catch(e => this.plugin.reportError(e)); });
        }
      })
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
        d.addOption("", "从检测结果选择…");
        for (const item of detectedOptions) d.addOption(item.value, item.label);
        d.setValue(s[opts.modelKey]).onChange(v => {
          if (v) void this.changeModel(opts.kind, v).catch(e => this.plugin.reportError(e));
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
    body.createEl("p", {
      text: "提示词引导对话、概念图和笔记整理，但不保证事实或格式正确。自定义内容会保留，点「恢复默认」使用新版。",
      cls: "cobrain-prompt-description",
    });
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
      t.inputEl.addClass("cobrain-setting-textarea");
    });
  }

  private promptTextArea(parent: HTMLElement, name: string, desc: string, key: StringKeys, defaultValue: string): void {
    const s = this.plugin.settings;
    let setValue: ((v: string) => void) | null = null;
    const setting = new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addTextArea(t => {
        setValue = (v: string) => { t.setValue(v); };
        t.setValue(s[key]).onChange(v => {
          s[key] = v;
          this.plugin.saveSettingsDebounced();
        });
        // 人设提示词动辄几百字，6 行的编辑窗口是在惩罚认真调提示词的用户
        t.inputEl.rows = 14;
        t.inputEl.addClass("cobrain-setting-textarea");
      })
      .addButton(b =>
        b.setButtonText("恢复默认").onClick(async () => {
          s[key] = defaultValue;
          setValue?.(defaultValue);
          await this.plugin.saveSettings();
          new Notice(`${name}已恢复默认`);
        }),
      );
    setting.settingEl.addClass("cobrain-prompt-setting");
  }

  private collapsible(
    container: HTMLElement,
    title: string,
    open: boolean,
  ): { body: HTMLElement; status: HTMLElement } {
    const details = container.createEl("details", { cls: "cobrain-settings-section" });
    details.open = open;
    const summary = details.createEl("summary");
    summary.createSpan({ text: title });
    const status = summary.createSpan({ cls: "cobrain-endpoint-status" });
    const body = details.createDiv({ cls: "cobrain-settings-section-body" });
    return { body, status };
  }

  private paintStatus(el: HTMLElement, status: EndpointStatus): void {
    el.removeClass("is-ok", "is-fail");
    if (status.state === "ok") {
      el.setText(`● ${status.text ?? "已连通"}`);
      el.addClass("is-ok");
      return;
    }
    if (status.state === "fail") {
      el.setText(`✗ ${status.text ?? "失败"}`);
      el.addClass("is-fail");
      return;
    }
    el.setText(`○ ${status.text ?? "未测"}`);
  }

  private async changeModel(kind: EndpointKind, raw: string): Promise<void> {
    const key = MODEL_KEY[kind], value = raw.trim(), settings = this.plugin.settings;
    if (kind === "embed" && Platform.isMobile) {
      this.modelInputs[kind]?.setValue(settings[key]);
      this.refreshModelDropdown(kind);
      new Notice("嵌入模型请在桌面端更换（移动端只读）");
      return;
    }
    if (value === settings[key]) return;
    settings[key] = value;
    this.status[kind] = { state: "untested" };
    const status = this.statusEls[kind];
    if (status) this.paintStatus(status, this.status[kind]);
    this.modelInputs[kind]?.setValue(value);
    this.refreshModelDropdown(kind);
    if (kind === "embed") {
      await this.plugin.saveSettings();
      await this.plugin.resetIndexForEmbedModelChange();
      new Notice("嵌入模型已更换，旧索引已清空。请在桌面端重建允许范围的索引。");
    } else this.plugin.saveSettingsDebounced();
  }

  private refreshModelDropdown(kind: EndpointKind): void {
    const d = this.modelDropdowns[kind];
    if (!d) return;
    const current = this.plugin.settings[MODEL_KEY[kind]];
    d.selectEl.empty();
    d.addOption("", "从检测结果选择…");
    for (const opt of this.modelOptions(kind, current)) d.addOption(opt.value, opt.label);
    d.setValue(current);
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
        : "可手填模型名称，离开输入框后保存；也可检测后选择。移动端沿用桌面配置";
    }
    if (this.detected[kind].length) return `已检测到 ${count} 个候选模型，下拉选择`;
    return "可直接填写模型名称；检测只是辅助，不要求端点提供 /models";
  }
}
