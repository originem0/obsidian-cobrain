jest.mock("obsidian", () => ({
  PluginSettingTab: class {},
  Setting: class {},
  Notice: class {},
  DropdownComponent: class {},
  Platform: { isMobile: false },
}), { virtual: true });

import { DEFAULT_SETTINGS, normalizeSettingsData } from "./settings";
const previousDefaults = require("./testFixtures/prompts-0.6.0.json");

test("normalizeSettingsData 兼容旧版扁平 data.json 并剔除旧 index 字段", () => {
  const legacyIndex = { entries: [] };
  const out = normalizeSettingsData({
    llmBaseUrl: "https://chat.example/v1",
    llmKey: "chat-key",
    llmModel: "chat-model",
    embedBaseUrl: "https://embed.example/v1",
    embedModel: "embed-model",
    tutorPrompt: "custom tutor",
    appendConversation: true,
    index: legacyIndex,
  });

  expect(out.settings.llmBaseUrl).toBe("https://chat.example/v1");
  expect(out.settings.llmKey).toBe("chat-key");
  expect(out.settings.llmModel).toBe("chat-model");
  expect(out.settings.embedBaseUrl).toBe("https://embed.example/v1");
  expect(out.settings.embedModel).toBe("embed-model");
  expect(out.settings.tutorPrompt).toBe("custom tutor");
  expect(out.settings.appendConversation).toBe(true);
  expect((out.settings as any).index).toBeUndefined();
  expect(out.legacyIndex).toBe(legacyIndex);
});

test("normalizeSettingsData 兼容新版 settings 包装结构", () => {
  const out = normalizeSettingsData({
    settings: {
      imageBaseUrl: "https://image.example/v1",
      imageModel: "image-model",
      retrievalMinScore: 0.35,
      indexExcludeFolders: "Archive",
    },
  });

  expect((out.settings as any).imageBaseUrl).toBeUndefined();
  expect((out.settings as any).imageModel).toBeUndefined();
  expect(out.settings.retrievalMinScore).toBe(0.35);
  expect(out.settings.indexExcludeFolders).toBe("Archive");
  expect(out.settings.llmBaseUrl).toBe(DEFAULT_SETTINGS.llmBaseUrl);
});

test("normalizeSettingsData 把短暂发布过的错误默认排除列表迁回新默认", () => {
  const out = normalizeSettingsData({
    settings: {
      indexExcludeFolders: "cobrain-note, Templates, 模板, Archive, 归档",
    },
  });

  expect(out.settings.indexExcludeFolders).toBe("Templates, 模板, Archive, 归档");
});

test("DEFAULT_SETTINGS 新安装不预填第三方端点和模型", () => {
  expect(DEFAULT_SETTINGS.llmBaseUrl).toBe("");
  expect(DEFAULT_SETTINGS.llmModel).toBe("");
  expect(DEFAULT_SETTINGS.indexEnabled).toBe(false);
  expect(DEFAULT_SETTINGS.indexIncludeFolders).toBe("");
  expect(DEFAULT_SETTINGS.embedBaseUrl).toBe("");
  expect(DEFAULT_SETTINGS.embedModel).toBe("");
});


test("升级后不会沿用全库索引或无效预算，自定义人设保留", () => {
  const out = normalizeSettingsData({ settings: { tutorPrompt: "我的自定义规则", contextBudgetTokens: -1, imageKey: "旧密钥" } });
  expect(out.settings.tutorPrompt).toBe("我的自定义规则");
  expect(out.settings.indexEnabled).toBe(false);
  expect(out.settings.indexIncludeFolders).toBe("");
  expect(out.settings.contextBudgetTokens).toBe(4096);
  expect((out.settings as any).imageKey).toBeUndefined();
});

test.each([false, true])("原样 0.6.0 提示词升级为新版，兼容包装结构 %s", wrapped => {
  const data = { ...previousDefaults, llmBaseUrl: "https://chat.example/v1", noteFolder: "我的笔记" };
  const { settings } = normalizeSettingsData(wrapped ? { settings: data } : data);
  for (const key of ["tutorPrompt", "conceptMapPrompt", "notePrompt"] as const) {
    expect(settings[key]).toBe(DEFAULT_SETTINGS[key]);
    expect(settings[key]).not.toBe(previousDefaults[key]);
  }
  expect(settings.llmBaseUrl).toBe(data.llmBaseUrl);
  expect(settings.noteFolder).toBe(data.noteFolder);
  expect(normalizeSettingsData({ settings }).settings).toEqual(settings);
});

test("只修改一行的旧提示词也保留，未修改的其它提示词仍可升级", () => {
  for (const key of ["tutorPrompt", "conceptMapPrompt", "notePrompt"] as const) {
    const custom = `${previousDefaults[key]}\n保留这一行自定义规则。`;
    const { settings } = normalizeSettingsData({ settings: { ...previousDefaults, [key]: custom } });
    expect(settings[key]).toBe(custom);
    for (const other of ["tutorPrompt", "conceptMapPrompt", "notePrompt"] as const) {
      if (other !== key) expect(settings[other]).toBe(DEFAULT_SETTINGS[other]);
    }
  }
});
