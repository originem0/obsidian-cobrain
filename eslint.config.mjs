import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

// 与社区目录自动审核使用同一套规则（eslint-plugin-obsidianmd recommended），本地结果与线上评分卡逐条对应。
// 审核只扫插件源码与 manifest；测试、浏览器验证和构建脚本不进入发布包，这里同样不扫。
//
// 以下警告有意保留，数量记在 package.json 的 --max-warnings 中，新增任何警告都会让检查失败：
// - chatClient.ts 使用 fetch（2 处）：流式输出和真正中止请求只能用 fetch，requestUrl 不支持；CORS 失败时已回退 requestUrl。
// - 设置页未实现 getSettingDefinitions（1 处）：1.13 的声明式设置会取代 display() 渲染，最低版本 1.7.2 仍需要现有设置页。
// - no-deprecated（5 处）：display() 与 setDynamicTooltip() 在 1.13 之前没有替代；keyCode 229 是 Safari/iOS 输入法确认回车的唯一可靠信号。
export default [
  {
    ignores: [
      "main.js", "src/**/*.test.ts", "tests/**", "scripts/**", "docs/**", ".audit/**",
      "esbuild.config.mjs", "deploy.mjs", "jest.config.js", "eslint.config.mjs",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // 中文界面夹带的英文术语会被误判（例如要求把 Mermaid 方向 TD 改成 td），目录审核也不统计这一项。
    rules: { "obsidianmd/ui/sentence-case": "off" },
  },
  {
    // validate-manifest 依赖 TypeScript 解析 JSON 得到的语法树；描述含禁用词时目录会下架插件，因此按错误处理。
    files: ["manifest.json"],
    languageOptions: { parser: tseslint.parser, parserOptions: { extraFileExtensions: [".json"] } },
    rules: { "obsidianmd/validate-manifest": "error" },
  },
];
