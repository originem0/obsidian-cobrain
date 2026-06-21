jest.mock("obsidian", () => ({
  PluginSettingTab: class {},
  Setting: class {},
  Notice: class {},
  DropdownComponent: class {},
  Platform: { isMobile: false },
}), { virtual: true });

import { DEFAULT_SETTINGS, normalizeSettingsData } from "./settings";

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

  expect(out.settings.imageBaseUrl).toBe("https://image.example/v1");
  expect(out.settings.imageModel).toBe("image-model");
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
  expect(DEFAULT_SETTINGS.imageBaseUrl).toBe("");
  expect(DEFAULT_SETTINGS.imageModel).toBe("");
  expect(DEFAULT_SETTINGS.embedBaseUrl).toBe("");
  expect(DEFAULT_SETTINGS.embedModel).toBe("");
});
