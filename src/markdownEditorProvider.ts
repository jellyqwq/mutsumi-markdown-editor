import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
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
    }
  | {
      type: "exportDocument";
      requestId: string;
      format: ExportFormat;
      markdown: string;
      html: string;
    }
  | {
      type: "codeBlockTheme";
      theme: string;
    };

type ImageSaveResult = {
  link: string;
  alt: string;
};

type ImageTemplateValues = Record<string, string>;
type ExportFormat = "markdown" | "html" | "pdf";
type ExportDocumentMessage = Extract<EditorMessage, { type: "exportDocument" }>;

const execFileAsync = promisify(execFile);

export class MutsumiMarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "mutsumi.markdownEditor";
  private static readonly outlineStateKey = "mutsumiMarkdown.outlineEnabled";

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new MutsumiMarkdownEditorProvider(context);

    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(MutsumiMarkdownEditorProvider.viewType, provider, {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }),
      vscode.commands.registerCommand("mutsumiMarkdown.table.insertRowAbove", () => provider.postTableAction("insertRowAbove")),
      vscode.commands.registerCommand("mutsumiMarkdown.table.insertRowBelow", () => provider.postTableAction("insertRowBelow")),
      vscode.commands.registerCommand("mutsumiMarkdown.table.insertColumnLeft", () => provider.postTableAction("insertColumnLeft")),
      vscode.commands.registerCommand("mutsumiMarkdown.table.insertColumnRight", () => provider.postTableAction("insertColumnRight")),
      vscode.commands.registerCommand("mutsumiMarkdown.table.deleteRow", () => provider.postTableAction("deleteRow")),
      vscode.commands.registerCommand("mutsumiMarkdown.table.deleteColumn", () => provider.postTableAction("deleteColumn")),
      vscode.commands.registerCommand("mutsumiMarkdown.table.alignLeft", () => provider.postTableAction("alignLeft")),
      vscode.commands.registerCommand("mutsumiMarkdown.table.alignCenter", () => provider.postTableAction("alignCenter")),
      vscode.commands.registerCommand("mutsumiMarkdown.table.alignRight", () => provider.postTableAction("alignRight")),
      vscode.commands.registerCommand("mutsumiMarkdown.export.markdown", () => provider.postExportRequest("markdown")),
      vscode.commands.registerCommand("mutsumiMarkdown.export.html", () => provider.postExportRequest("html")),
      vscode.commands.registerCommand("mutsumiMarkdown.export.pdf", () => provider.postExportRequest("pdf")),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("mutsumiMarkdown.codeBlockTheme")) {
          provider.postCodeBlockThemeToPanels();
        }
      }),
    );
  }

  private readonly panels = new Map<vscode.WebviewPanel, vscode.TextDocument>();

  private constructor(private readonly context: vscode.ExtensionContext) {}

  private async postTableAction(action: string): Promise<void> {
    const panel = this.activePanel();
    await panel?.webview.postMessage({
      type: "tableAction",
      action,
    });
  }

  private async postExportRequest(format: ExportFormat): Promise<void> {
    const panel = this.activePanel();
    if (!panel) {
      vscode.window.showWarningMessage("Open a Markdown file with Mutsumi Markdown Editor before exporting.");
      return;
    }

    await panel?.webview.postMessage({
      type: "requestExport",
      format,
    });
  }

  private activePanel(): vscode.WebviewPanel | undefined {
    const panels = Array.from(this.panels.keys());
    return panels.find((item) => item.active) ?? panels.find((item) => item.visible);
  }

  private postCodeBlockThemeToPanels(): void {
    for (const [panel, document] of this.panels) {
      this.postCodeBlockTheme(panel.webview, document);
    }
  }

  private async postCodeBlockTheme(webview: vscode.Webview, document: vscode.TextDocument): Promise<void> {
    const config = vscode.workspace.getConfiguration("mutsumiMarkdown", document.uri);
    await webview.postMessage({
      type: "setCodeBlockTheme",
      theme: normalizeCodeBlockTheme(config.get("codeBlockTheme", "github")),
    });
  }

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
    this.panels.set(webviewPanel, document);

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
      this.panels.delete(webviewPanel);
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

        case "codeBlockTheme":
          try {
            await this.updateCodeBlockTheme(document, message.theme);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Mutsumi Markdown Editor: ${messageText}`);
          }
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

        case "exportDocument":
          try {
            const result = await this.exportDocument(document, workspaceFolder, message);
            await webviewPanel.webview.postMessage({
              type: "exportFinished",
              requestId: message.requestId,
              path: result.fsPath,
            });
            vscode.window.showInformationMessage(`Exported ${path.basename(result.fsPath)}.`);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            await webviewPanel.webview.postMessage({
              type: "exportFailed",
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
    const codeBlockTheme = normalizeCodeBlockTheme(config.get("codeBlockTheme", "github"));

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
      codeBlockTheme,
    });
  }

  private async updateCodeBlockTheme(document: vscode.TextDocument, theme: string): Promise<void> {
    const codeBlockTheme = normalizeCodeBlockTheme(theme);
    const config = vscode.workspace.getConfiguration("mutsumiMarkdown", document.uri);
    if (normalizeCodeBlockTheme(config.get("codeBlockTheme", "github")) === codeBlockTheme) {
      return;
    }

    const target = vscode.workspace.getWorkspaceFolder(document.uri)
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await config.update("codeBlockTheme", codeBlockTheme, target);
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

  private async exportDocument(
    document: vscode.TextDocument,
    workspaceFolder: vscode.WorkspaceFolder | undefined,
    message: ExportDocumentMessage,
  ): Promise<{ fsPath: string }> {
    const documentDir = path.dirname(document.uri.fsPath);
    const documentBaseName = path.parse(document.uri.fsPath).name;

    switch (message.format) {
      case "markdown": {
        const targetPath = path.join(documentDir, `${documentBaseName}.export.md`);
        await fs.writeFile(targetPath, message.markdown, "utf8");
        return { fsPath: targetPath };
      }

      case "html": {
        const targetPath = path.join(documentDir, `${documentBaseName}.html`);
        const html = await this.buildExportHtml(document, workspaceFolder, message.html);
        await fs.writeFile(targetPath, html, "utf8");
        return { fsPath: targetPath };
      }

      case "pdf": {
        const targetPath = path.join(documentDir, `${documentBaseName}.pdf`);
        const html = await this.buildExportHtml(document, workspaceFolder, message.html);
        await this.exportPdf(document, html, targetPath);
        return { fsPath: targetPath };
      }
    }
  }

  private async buildExportHtml(
    document: vscode.TextDocument,
    workspaceFolder: vscode.WorkspaceFolder | undefined,
    contentHtml: string,
  ): Promise<string> {
    const config = vscode.workspace.getConfiguration("mutsumiMarkdown", document.uri);
    const publicDir = normalizeRelativePath(config.get("publicDir", "src/.vuepress/public"));
    const imageRoot = normalizeRelativePath(config.get("imageRoot", "images"));
    const codeBlockTheme = normalizeCodeBlockTheme(config.get("codeBlockTheme", "github"));
    const publicDirPath = workspaceFolder ? path.join(workspaceFolder.uri.fsPath, publicDir) : undefined;
    const inlinedHtml = await inlineLocalImageSources(contentHtml, {
      documentDir: path.dirname(document.uri.fsPath),
      publicDirPath,
      imageRoot,
    });
    const vditorCss = await fs.readFile(path.join(this.context.extensionUri.fsPath, "node_modules", "vditor", "dist", "index.css"), "utf8");
    const codeBlockThemeCss = await readCodeBlockThemeCss(this.context.extensionUri.fsPath, codeBlockTheme);
    const abcRuntime = await this.buildAbcRuntime(inlinedHtml);

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(path.basename(document.uri.fsPath))}</title>
  <style>
${vditorCss}
${codeBlockThemeCss}
  </style>
  <style>
    html,
    body {
      margin: 0;
      background: #ffffff;
      color: #24292f;
    }

    body {
      padding: 32px;
    }

    .mutsumi-export {
      max-width: 960px;
      margin: 0 auto;
      overflow: visible;
    }

    .mutsumi-export .mutsumi-export-abc-container,
    .mutsumi-export pre:has(.language-abc) {
      padding: 0 !important;
      border: 0 !important;
      background: transparent !important;
      overflow: visible !important;
      page-break-inside: avoid;
      break-inside: avoid;
    }

    .mutsumi-export .language-abc {
      display: block;
      color: #111111 !important;
      background: transparent !important;
      text-align: center;
      overflow: visible !important;
    }

    .mutsumi-export .language-abc svg {
      display: block;
      margin-inline: auto;
      padding: 16px 20px;
      border: 1px solid rgba(0, 0, 0, 0.16);
      border-radius: 2px;
      box-sizing: border-box;
      color: #111111 !important;
      background: #f7f5ed !important;
      max-width: 100%;
      height: auto;
      overflow: visible;
    }

    @media print {
      body {
        padding: 0;
      }

      .mutsumi-export {
        max-width: none;
      }
    }
  </style>
</head>
<body>
  <main class="vditor-reset mutsumi-export">
${inlinedHtml}
  </main>
${abcRuntime}
</body>
</html>`;
  }

  private async buildAbcRuntime(html: string): Promise<string> {
    if (!/\blanguage-abc\b/.test(html)) {
      return "";
    }

    const abcScript = await fs.readFile(
      path.join(this.context.extensionUri.fsPath, "node_modules", "vditor", "dist", "js", "abcjs", "abcjs_basic.min.js"),
      "utf8",
    );

    return /* html */ `
  <script>
${escapeScriptContent(abcScript)}
  </script>
  <script>
${exportAbcRenderScript()}
  </script>`;
  }

  private async exportPdf(document: vscode.TextDocument, html: string, targetPath: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("mutsumiMarkdown", document.uri);
    const chromiumPath = await findChromiumExecutable(config.get("chromiumPath", ""));
    const pdfMarginTop = Math.max(0, config.get("pdfMarginTop", 25));
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, {
        waitUntil: "load",
      });
      await page.evaluate(async () => {
        const ready = (globalThis as { __mutsumiExportReady?: Promise<void> }).__mutsumiExportReady;
        if (ready && typeof ready.then === "function") {
          await ready;
        }
      });
      await page.waitForNetworkIdle({
        timeout: 30000,
      });
      await page.pdf({
        path: targetPath,
        format: "A4",
        printBackground: true,
        margin: {
          top: `${pdfMarginTop}mm`,
          right: "16mm",
          bottom: "18mm",
          left: "16mm",
        },
      });
    } finally {
      await browser.close();
    }
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

async function inlineLocalImageSources(html: string, options: {
  documentDir: string;
  publicDirPath: string | undefined;
  imageRoot: string;
}): Promise<string> {
  return replaceAsync(html, /\s(src)=("([^"]*)"|'([^']*)')/gi, async (match, attribute: string, quoted: string, doubleValue: string, singleValue: string) => {
    const value = doubleValue ?? singleValue ?? "";
    const dataUri = await localImageToDataUri(value, options);
    if (!dataUri) {
      return match;
    }

    return ` ${attribute}=${quoted[0]}${escapeHtmlAttribute(dataUri)}${quoted[0]}`;
  });
}

async function localImageToDataUri(value: string, options: {
  documentDir: string;
  publicDirPath: string | undefined;
  imageRoot: string;
}): Promise<string | undefined> {
  const imagePath = resolveLocalImagePath(value, options);
  if (!imagePath) {
    return undefined;
  }

  try {
    const buffer = await fs.readFile(imagePath);
    return `data:${mimeForPath(imagePath)};base64,${buffer.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function resolveLocalImagePath(value: string, options: {
  documentDir: string;
  publicDirPath: string | undefined;
  imageRoot: string;
}): string | undefined {
  const decoded = decodeHtmlAttribute(value).trim();
  if (!decoded || /^(?:data:|https?:|mailto:|tel:|#|vscode-webview-resource:|vscode-resource:)/i.test(decoded)) {
    return undefined;
  }

  if (decoded.startsWith("file:")) {
    try {
      return vscode.Uri.parse(decoded).fsPath;
    } catch {
      return undefined;
    }
  }

  const cleanValue = decodeUriPath(decoded.replace(/[?#].*$/, ""));
  const imageRoot = options.imageRoot.replace(/^\/+|\/+$/g, "");
  if (cleanValue.startsWith("/") && options.publicDirPath) {
    return path.join(options.publicDirPath, cleanValue.replace(/^\/+/, ""));
  }

  if (imageRoot && cleanValue.startsWith(`${imageRoot}/`) && options.publicDirPath) {
    return path.join(options.publicDirPath, cleanValue);
  }

  if (path.isAbsolute(cleanValue)) {
    return cleanValue;
  }

  return path.resolve(options.documentDir, cleanValue);
}

function decodeUriPath(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function mimeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".bmp":
      return "image/bmp";
    case ".ico":
      return "image/x-icon";
    default:
      return "image/png";
  }
}

async function replaceAsync(
  value: string,
  pattern: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const matches = Array.from(value.matchAll(pattern));
  const replacements = await Promise.all(matches.map((match) => replacer(...match)));
  let index = 0;

  return value.replace(pattern, () => replacements[index++]);
}

async function findChromiumExecutable(configuredPath: string): Promise<string> {
  const trimmedPath = configuredPath.trim();
  if (trimmedPath) {
    if (await pathExists(trimmedPath)) {
      return trimmedPath;
    }

    throw new Error(`Chromium executable was not found: ${trimmedPath}`);
  }

  const environmentPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (environmentPath && await pathExists(environmentPath)) {
    return environmentPath;
  }

  for (const candidate of chromiumCandidates()) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  for (const command of chromiumCommands()) {
    const resolved = await findCommandOnPath(command);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error("Chrome or Chromium was not found. Set mutsumiMarkdown.chromiumPath to enable PDF export.");
}

function chromiumCandidates(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      path.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      path.join(home, "Applications", "Chromium.app", "Contents", "MacOS", "Chromium"),
      path.join(home, "Applications", "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"),
    );
  } else if (process.platform === "win32") {
    const prefixes = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean) as string[];

    for (const prefix of prefixes) {
      candidates.push(
        path.join(prefix, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(prefix, "Chromium", "Application", "chrome.exe"),
        path.join(prefix, "Microsoft", "Edge", "Application", "msedge.exe"),
      );
    }
  }

  return candidates;
}

function chromiumCommands(): string[] {
  if (process.platform === "win32") {
    return ["chrome.exe", "msedge.exe"];
  }

  return ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium", "microsoft-edge", "msedge"];
}

async function findCommandOnPath(command: string): Promise<string | undefined> {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  try {
    const result = await execFileAsync(lookupCommand, [command]);
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

async function readCodeBlockThemeCss(extensionPath: string, theme: string): Promise<string> {
  const themePath = codeBlockThemeCssPath(extensionPath, theme);
  if (await pathExists(themePath)) {
    return fs.readFile(themePath, "utf8");
  }

  return fs.readFile(codeBlockThemeCssPath(extensionPath, "github"), "utf8");
}

function codeBlockThemeCssPath(extensionPath: string, theme: string): string {
  const safeTheme = normalizeCodeBlockTheme(theme);
  return path.join(
    extensionPath,
    "node_modules",
    "vditor",
    "dist",
    "js",
    "highlight.js",
    "styles",
    ...safeTheme.split("/"),
  ) + ".min.css";
}

function normalizeCodeBlockTheme(theme: string | undefined): string {
  const value = (theme || "").trim().replace(/^\/+|\/+$/g, "");
  if (!value || value.includes("..") || path.isAbsolute(value) || !/^[a-zA-Z0-9/_-]+$/.test(value)) {
    return "github";
  }

  return value;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeScriptContent(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function exportAbcRenderScript(): string {
  return String.raw`(function () {
  function normalizeSvg(root) {
    root.querySelectorAll("svg").forEach(function (svg) {
      var width = parseFloat(svg.getAttribute("width") || "");
      var height = parseFloat(svg.getAttribute("height") || "");

      if (!svg.getAttribute("viewBox") && width > 0 && height > 0) {
        svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      }

      svg.style.display = "block";
      svg.style.marginLeft = "auto";
      svg.style.marginRight = "auto";
      svg.style.maxWidth = "100%";
      svg.style.height = "auto";
      svg.style.overflow = "visible";
      svg.style.background = "#f7f5ed";
    });
  }

  function renderAbcBlocks() {
    document.querySelectorAll(".language-abc").forEach(function (block) {
      var container = block.closest("pre") || block;
      container.classList.add("mutsumi-export-abc-container");

      if (block.querySelector("svg")) {
        normalizeSvg(block);
        return;
      }

      var code = block.textContent || "";
      if (!code.trim() || !window.ABCJS || typeof window.ABCJS.renderAbc !== "function") {
        return;
      }

      try {
        block.textContent = "";
        window.ABCJS.renderAbc(block, code.trim(), {}, {}, { responsive: "resize" });
        block.setAttribute("data-processed", "true");
        normalizeSvg(block);
      } catch (error) {
        block.textContent = code;
        block.classList.add("vditor-reset--error");
        console.error(error);
      }
    });
  }

  window.__mutsumiExportReady = new Promise(function (resolve) {
    var run = function () {
      renderAbcBlocks();
      requestAnimationFrame(function () {
        requestAnimationFrame(resolve);
      });
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
  });
})();`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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
