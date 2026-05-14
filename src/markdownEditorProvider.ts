import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

type EditorMessage =
  | { type: "ready" }
  | { type: "update"; text: string }
  | { type: "outlineState"; enabled: boolean }
  | {
      type: "saveImage";
      requestId: string;
      name?: string;
      mime?: string;
      dataUrl: string;
    };

type ImageSaveResult = {
  link: string;
  alt: string;
};

type ImageTemplateValues = Record<string, string>;

export class MutsumiMarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "mutsumi.markdownEditor";
  private static readonly outlineStateKey = "mutsumiMarkdown.outlineEnabled";

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new MutsumiMarkdownEditorProvider(context);

    return vscode.window.registerCustomEditorProvider(MutsumiMarkdownEditorProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri,
        ...(workspaceFolder ? [workspaceFolder.uri] : []),
      ],
    };

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview, workspaceFolder, document);

    let lastTextFromWebview = document.getText();
    let applyingWebviewEdit = false;

    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString()) {
        return;
      }

      const text = event.document.getText();
      if (applyingWebviewEdit || text === lastTextFromWebview) {
        return;
      }

      webviewPanel.webview.postMessage({
        type: "setContent",
        text,
      });
    });

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
    });

    webviewPanel.webview.onDidReceiveMessage(async (message: EditorMessage) => {
      switch (message.type) {
        case "ready":
          await this.postInitialState(webviewPanel.webview, workspaceFolder, document);
          return;

        case "update":
          lastTextFromWebview = message.text;
          applyingWebviewEdit = true;
          try {
            await this.updateTextDocument(document, message.text);
          } finally {
            applyingWebviewEdit = false;
          }
          return;

        case "outlineState":
          await this.context.workspaceState.update(MutsumiMarkdownEditorProvider.outlineStateKey, message.enabled);
          return;

        case "saveImage":
          try {
            const result = await this.saveImage(document, message);
            await webviewPanel.webview.postMessage({
              type: "imageSaved",
              requestId: message.requestId,
              ...result,
            });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            await webviewPanel.webview.postMessage({
              type: "imageSaveFailed",
              requestId: message.requestId,
              message: messageText,
            });
            vscode.window.showErrorMessage(`Mutsumi Markdown Editor: ${messageText}`);
          }
          return;
      }
    });
  }

  private async postInitialState(
    webview: vscode.Webview,
    workspaceFolder: vscode.WorkspaceFolder | undefined,
    document: vscode.TextDocument,
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration("mutsumiMarkdown", document.uri);
    const publicDir = normalizeRelativePath(config.get("publicDir", "src/.vuepress/public"));
    const imageRoot = normalizeRelativePath(config.get("imageRoot", "images"));
    const outlineDefaultOpen = config.get("outlineDefaultOpen", false);
    const outlineEnabled = this.context.workspaceState.get(MutsumiMarkdownEditorProvider.outlineStateKey, outlineDefaultOpen);

    const workspacePath = workspaceFolder?.uri.fsPath;
    const publicDirPath = workspacePath ? path.join(workspacePath, publicDir) : undefined;
    const documentDirPath = path.dirname(document.uri.fsPath);

    await webview.postMessage({
      type: "init",
      text: document.getText(),
      vditorCdnUri: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "node_modules", "vditor")).toString(),
      publicBaseUri: publicDirPath ? webview.asWebviewUri(vscode.Uri.file(publicDirPath)).toString() : undefined,
      documentDirUri: webview.asWebviewUri(vscode.Uri.file(documentDirPath)).toString(),
      imageRoot: `/${imageRoot}`,
      outlineEnabled,
    });
  }

  private async updateTextDocument(document: vscode.TextDocument, text: string): Promise<void> {
    if (document.getText() === text) {
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, wholeDocumentRange(document), text);
    const success = await vscode.workspace.applyEdit(edit);

    if (!success) {
      throw new Error("Failed to update Markdown document.");
    }
  }

  private async saveImage(
    document: vscode.TextDocument,
    message: Extract<EditorMessage, { type: "saveImage" }>,
  ): Promise<ImageSaveResult> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      throw new Error("Open a workspace before pasting images.");
    }

    const parsedDataUrl = parseDataUrl(message.dataUrl);
    const ext = inferExtension(message.name, message.mime, parsedDataUrl.mime);
    const config = vscode.workspace.getConfiguration("mutsumiMarkdown", document.uri);

    const workspacePath = workspaceFolder.uri.fsPath;
    const publicDir = normalizeRelativePath(config.get("publicDir", "src/.vuepress/public"));
    const imageRoot = normalizeRelativePath(config.get("imageRoot", "images"));
    const contentRoot = normalizeRelativePath(config.get("contentRoot", "src"));
    const imageNameTemplate = config.get("imageName", "${timestamp}.${ext}");
    const imagePathTemplate = config.get("imagePathTemplate", "").trim();
    const markdownImagePathTemplate = config.get("markdownImagePathTemplate", "").trim();

    const timestamp = String(Date.now());
    const articlePath = articleImagePath(document, workspacePath, contentRoot);
    const articleInfo = articlePathInfo(document, workspacePath, contentRoot);
    const imageName = renderImageName(imageNameTemplate, {
      ext,
      originalName: message.name,
      fileName: articleInfo.fileName,
      timestamp,
    });
    const publicDirPath = path.join(workspacePath, publicDir);
    const templateValues = imageTemplateValues({
      workspacePath,
      publicDir,
      imageRoot,
      contentRoot,
      articlePath,
      articleInfo,
      imageName,
      timestamp,
      ext,
      originalName: message.name,
    });
    const renderedImagePath = imagePathTemplate
      ? normalizeTemplatePath(renderTemplate(imagePathTemplate, templateValues))
      : path.posix.join(publicDir, imageRoot, articlePath, imageName);
    const targetPath = resolveWorkspacePath(workspacePath, renderedImagePath);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, parsedDataUrl.buffer);

    const link = markdownImagePathTemplate
      ? normalizeMarkdownLink(renderTemplate(markdownImagePathTemplate, {
        ...templateValues,
        imagePath: renderedImagePath,
      }))
      : markdownLinkForTarget(targetPath, document.uri.fsPath, publicDirPath);

    return {
      link,
      alt: path.parse(message.name || imageName).name || "image",
    };
  }

  private getHtml(
    webview: vscode.Webview,
    workspaceFolder: vscode.WorkspaceFolder | undefined,
    document: vscode.TextDocument,
  ): string {
    const nonce = getNonce();
    const vditorCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "node_modules", "vditor", "dist", "index.css"));
    const vditorJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "node_modules", "vditor", "dist", "index.min.js"));
    const vditorIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "node_modules", "vditor", "dist", "js", "icons", "ant.js"));
    const editorCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "editor.css"));
    const editorJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "editor.js"));

    const publicDir = normalizeRelativePath(
      vscode.workspace.getConfiguration("mutsumiMarkdown", document.uri).get("publicDir", "src/.vuepress/public"),
    );
    const publicDirUri = workspaceFolder
      ? webview.asWebviewUri(vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, publicDir)))
      : undefined;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} ${publicDirUri ?? ""} data: https: http:; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <link rel="stylesheet" href="${vditorCssUri}">
  <link rel="stylesheet" href="${editorCssUri}">
  <title>Mutsumi Markdown Editor</title>
</head>
<body>
  <main id="app">
    <div id="editor"></div>
  </main>
  <script id="vditorIconScript" nonce="${nonce}" src="${vditorIconUri}"></script>
  <script nonce="${nonce}" src="${vditorJsUri}"></script>
  <script nonce="${nonce}" src="${editorJsUri}"></script>
</body>
</html>`;
  }
}

function wholeDocumentRange(document: vscode.TextDocument): vscode.Range {
  const lastLine = document.lineAt(document.lineCount - 1);
  return new vscode.Range(0, 0, document.lineCount - 1, lastLine.text.length);
}

function articleImagePath(document: vscode.TextDocument, workspacePath: string, contentRoot: string): string {
  const info = articlePathInfo(document, workspacePath, contentRoot);
  return info.relativePath;
}

function articlePathInfo(document: vscode.TextDocument, workspacePath: string, contentRoot: string) {
  const workspaceRelativeDocumentPath = toPosixPath(path.relative(workspacePath, document.uri.fsPath));
  const contentRelativeDocumentPath = stripPathPrefix(workspaceRelativeDocumentPath, contentRoot);
  const parsed = path.posix.parse(contentRelativeDocumentPath);
  const relativeDir = parsed.dir;
  const fileName = parsed.name;

  return {
    workspaceRelativeDocumentPath,
    contentRelativeDocumentPath,
    relativeDir,
    fileName,
    relativePath: path.posix.join(relativeDir, fileName),
  };
}

function stripPathPrefix(filePath: string, prefix: string): string {
  if (!prefix) {
    return filePath;
  }

  if (filePath === prefix) {
    return "";
  }

  if (filePath.startsWith(`${prefix}/`)) {
    return filePath.slice(prefix.length + 1);
  }

  return filePath;
}

function imageTemplateValues(values: {
  workspacePath: string;
  publicDir: string;
  imageRoot: string;
  contentRoot: string;
  articlePath: string;
  articleInfo: ReturnType<typeof articlePathInfo>;
  imageName: string;
  timestamp: string;
  ext: string;
  originalName?: string;
}): ImageTemplateValues {
  const originalName = values.originalName ? path.parse(values.originalName).name : "image";

  return {
    workspaceDir: toPosixPath(values.workspacePath),
    publicDir: values.publicDir,
    imageRoot: values.imageRoot,
    contentRoot: values.contentRoot,
    relativeDir: values.articleInfo.relativeDir,
    fileName: values.articleInfo.fileName,
    relativePath: values.articlePath,
    documentPath: values.articleInfo.workspaceRelativeDocumentPath,
    contentDocumentPath: values.articleInfo.contentRelativeDocumentPath,
    imageName: values.imageName,
    timestamp: values.timestamp,
    now: values.timestamp,
    ext: values.ext,
    originalName: sanitizePathSegment(originalName),
  };
}

function renderImageName(template: string, values: { ext: string; originalName?: string; fileName: string; timestamp: string }): string {
  const originalName = values.originalName ? path.parse(values.originalName).name : "image";

  return sanitizePathSegment(renderTemplate(template, {
    timestamp: values.timestamp,
    now: values.timestamp,
    fileName: values.fileName,
    originalName: sanitizePathSegment(originalName),
    ext: values.ext,
  }));
}

function renderTemplate(template: string, values: ImageTemplateValues): string {
  return template.replace(/\$\{([^}]+)\}/g, (match, key: string) => values[key] ?? match);
}

function normalizeTemplatePath(value: string): string {
  return toPosixPath(value).replace(/\/+/g, "/").replace(/\/$/g, "");
}

function resolveWorkspacePath(workspacePath: string, templatePath: string): string {
  if (path.isAbsolute(templatePath)) {
    return templatePath;
  }

  return path.join(workspacePath, ...templatePath.split("/"));
}

function markdownLinkForTarget(targetPath: string, documentPath: string, publicDirPath: string): string {
  const publicRelativePath = toPosixPath(path.relative(publicDirPath, targetPath));
  if (publicRelativePath && !publicRelativePath.startsWith("../") && publicRelativePath !== ".." && !path.isAbsolute(publicRelativePath)) {
    return `/${publicRelativePath}`;
  }

  return normalizeMarkdownLink(toPosixPath(path.relative(path.dirname(documentPath), targetPath)));
}

function normalizeMarkdownLink(value: string): string {
  return toPosixPath(value).replace(/ /g, "%20");
}

function parseDataUrl(dataUrl: string): { mime: string | undefined; buffer: Buffer } {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("Unsupported image data.");
  }

  return {
    mime: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

function inferExtension(fileName: string | undefined, messageMime: string | undefined, dataMime: string | undefined): string {
  const extension = fileName ? path.extname(fileName).replace(".", "").toLowerCase() : "";
  if (extension) {
    return extension;
  }

  const mime = (messageMime || dataMime || "").toLowerCase();
  switch (mime) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "png";
  }
}

function normalizeRelativePath(value: string): string {
  return toPosixPath(value).replace(/^\/+|\/+$/g, "");
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-");
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return text;
}
