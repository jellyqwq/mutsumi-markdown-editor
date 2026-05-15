# Mutsumi Markdown Editor

Mutsumi Markdown Editor 是一个基于 Vditor 的 VS Code Markdown 所见即所得编辑器。

它主要为 VuePress 博客写作准备：在编辑 Markdown 时直接粘贴图片，把图片保存到仓库的 public 目录，并在正文里插入可被 VuePress 和 GitHub 访问的 `/images/...` 链接。

## 功能

- 使用 Vditor 提供 Markdown 所见即所得编辑体验。
- 粘贴图片时自动保存到项目目录。
- 支持按文章路径生成图片目录。
- 支持通过模板自定义图片保存路径。
- 本地预览 `/images/...` 图片时自动映射到 public 目录。
- 大纲打开或关闭状态会在当前 workspace 中记住。
- 可以让 Git diff 继续使用 VS Code 普通文本比对。
- 跟随 VS Code 明暗主题。

## 使用

安装扩展后，在 Markdown 文件中执行：

```text
Open With... -> Mutsumi Markdown Editor
```

如果想让 `.md` 默认使用这个编辑器，可以在 VS Code 设置里配置：

```json
{
  "workbench.editorAssociations": {
    "*.md": "mutsumi.markdownEditor"
  }
}
```

如果默认使用 Mutsumi，又希望 Git 比对仍然是普通文本 diff，可以加：

```json
{
  "workbench.diffEditorAssociations": {
    "*.md": "default"
  }
}
```

## 图片路径

默认配置适合 VuePress 项目：

```json
{
  "mutsumiMarkdown.publicDir": "src/.vuepress/public",
  "mutsumiMarkdown.imageRoot": "images",
  "mutsumiMarkdown.contentRoot": "src",
  "mutsumiMarkdown.imageName": "${timestamp}.${ext}"
}
```

例如打开：

```text
src/life/journal/2026-05-07.md
```

粘贴图片会保存为：

```text
src/.vuepress/public/images/life/journal/2026-05-07/<timestamp>.png
```

Markdown 中插入：

```text
/images/life/journal/2026-05-07/<timestamp>.png
```

也可以在项目的 `.vscode/settings.json` 里显式写路径模板：

```json
{
  "mutsumiMarkdown.imagePathTemplate": "${publicDir}/${imageRoot}/${relativeDir}/${fileName}/${timestamp}.${ext}"
}
```

常用模板参数：

```text
${workspaceDir}  当前 workspace 根目录
${publicDir}     public 目录，例如 src/.vuepress/public
${imageRoot}     图片根目录，例如 images
${contentRoot}   内容根目录，例如 src
${relativeDir}   当前文章相对 contentRoot 的目录，例如 life/journal
${fileName}      当前文章文件名，不含扩展名，例如 2026-05-07
${relativePath}  ${relativeDir}/${fileName}
${timestamp}     当前时间戳
${now}           ${timestamp} 的别名
${ext}           图片扩展名
${originalName}  原始图片文件名，不含扩展名
${imageName}     根据 mutsumiMarkdown.imageName 生成的图片文件名
```

如果需要自定义 Markdown 中插入的图片链接，可以配置：

```json
{
  "mutsumiMarkdown.markdownImagePathTemplate": "/images/${relativeDir}/${fileName}/${imageName}"
}
```

不配置时，插件会从 `publicDir` 自动推导链接。

## 开发

```bash
npm install
npm run compile
```

在 VS Code 中按 `F5` 启动 Extension Development Host。默认会打开 `/Users/jelly/Code/Blog` 作为调试 workspace。

打包：

```bash
npx @vscode/vsce package
```

## 发布 GitHub Release

推送形如 `v0.0.7` 的 tag 时，GitHub Actions 会自动打包 VSIX，并把它上传到同名 Release。

发布一个新版本：

```bash
git tag v0.0.7
git push origin main --tags
```

tag 版本必须和 `package.json` 里的 `version` 一致。如果只想推送代码但不发 Release，就只推分支，不推新 tag。
