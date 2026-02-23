import * as vscode from "vscode";

export interface PlanRecord {
  readonly filePath: string;
  readonly uri: vscode.Uri;
  readonly fileName: string;
  readonly title: string;
  readonly timestampMs: number;
  readonly size: number;
  readonly dateKey: string;
  readonly dateLabel: string;
  readonly timeLabel: string;
}

export interface PlanQuickPickItem extends vscode.QuickPickItem {
  readonly uri?: vscode.Uri;
}
