# Mutsumi Markdown Editor

一个基于 Vditor 的 VS Code Markdown 所见即所得编辑器。

它的第一个目标很明确：给 VuePress 博客粘贴图片时，把图片保存到仓库里的 `src/.vuepress/public/images/...`，并在 Markdown 中写入可在线访问的 `/images/...` 链接。

## 默认图片规则

打开 `src/life/journal/2026-05-07.md` 后粘贴图片，会保存为：

```text
src/.vuepress/public/images/life/journal/2026-05-07/<timestamp>.png
```

Markdown 中插入的图片地址为：

```text
/images/life/journal/2026-05-07/<timestamp>.png
```

也可以在项目的 `.vscode/settings.json` 里显式写路径模板：

```json
{
  "mutsumiMarkdown.publicDir": "src/.vuepress/public",
  "mutsumiMarkdown.imageRoot": "images",
  "mutsumiMarkdown.contentRoot": "src",
  "mutsumiMarkdown.imagePathTemplate": "${publicDir}/${imageRoot}/${relativeDir}/${fileName}/${timestamp}.${ext}"
}
```

`src/life/journal/2026-05-07.md` 会把 `${relativeDir}` 解析为 `life/journal`，把 `${fileName}` 解析为 `2026-05-07`。

## 开发

```bash
npm install
npm run compile
```

然后在 VS Code 里按 `F5` 启动 Extension Development Host，右键 `.md` 文件选择 `Open With...`，再选择 `Mutsumi Markdown Editor`。
