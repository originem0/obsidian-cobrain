jest.mock("obsidian", () => ({
  Platform: { isMobile: false },
  normalizePath: (p: string) => p.replace(/\\/g, "/"),
}), { virtual: true });

import { IndexStore } from "./indexStore";
import { VectorStore } from "./vectorStore";

function legacyIndex() {
  return {
    embedModel: "embed-old",
    entries: [{ path: "a.md", chunkIdx: 0, text: "猫", heading: "", vector: [1, 0] }],
    mtimes: { "a.md": 1 },
    hashes: { "a.md": "h" },
  };
}

function mockApp(adapter: any) {
  return {
    vault: {
      adapter,
      configDir: ".obsidian",
    },
  } as any;
}

test("IndexStore 移动端从 data.json.index 只读加载，不写、不删、不回写 data.json", async () => {
  const adapter = {
    exists: jest.fn().mockResolvedValue(false),
    list: jest.fn(),
    read: jest.fn(),
    write: jest.fn(),
    mkdir: jest.fn(),
    remove: jest.fn(),
    rmdir: jest.fn(),
  };
  const store = new VectorStore();
  const indexStore = new IndexStore(mockApp(adapter), { id: "cobrain", dir: ".obsidian/plugins/cobrain" } as any, store, true);
  const migrated = jest.fn();

  const model = await indexStore.load({ legacyDataIndex: legacyIndex(), onMigratedLegacyDataIndex: migrated });

  expect(model).toBe("embed-old");
  expect(store.query([1, 0], 1)[0].path).toBe("a.md");
  expect(adapter.write).not.toHaveBeenCalled();
  expect(adapter.mkdir).not.toHaveBeenCalled();
  expect(adapter.remove).not.toHaveBeenCalled();
  expect(migrated).not.toHaveBeenCalled();
});

test("IndexStore 桌面端从 data.json.index 写出分片后回调删除旧字段", async () => {
  const adapter = {
    exists: jest.fn().mockResolvedValue(false),
    list: jest.fn(),
    read: jest.fn(),
    write: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn(),
    rmdir: jest.fn(),
  };
  const store = new VectorStore();
  const indexStore = new IndexStore(mockApp(adapter), { id: "cobrain", dir: ".obsidian/plugins/cobrain" } as any, store, false);
  const migrated = jest.fn().mockResolvedValue(undefined);

  const model = await indexStore.load({ legacyDataIndex: legacyIndex(), onMigratedLegacyDataIndex: migrated });

  expect(model).toBe("embed-old");
  expect(adapter.write).toHaveBeenCalled();
  expect(adapter.write.mock.calls.some((call: unknown[]) => String(call[0]).endsWith("meta.json"))).toBe(true);
  expect(migrated).toHaveBeenCalledTimes(1);
});
