import * as vscode from "vscode";
import { MutsumiMarkdownEditorProvider } from "./markdownEditorProvider";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(MutsumiMarkdownEditorProvider.register(context));
}

export function deactivate() {}
