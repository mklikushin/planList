import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PlanQuickPickItem, PlanRecord } from "./types";

const LIST_PLANS_COMMAND_ID = "cursorPlans.listPlans";
const PLAN_FILE_SUFFIX = ".plan.md";

type IndexStatus = "ready" | "missing";

class PlanIndexCache implements vscode.Disposable {
  private readonly recordsByPath = new Map<string, PlanRecord>();
  private readonly dateFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  private readonly timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  private sortedRecords: PlanRecord[] = [];
  private pendingPaths = new Set<string>();
  private quickPickItemsCache: PlanQuickPickItem[] = [];
  private quickPickDirty = true;
  private cacheWarm = false;
  private forceFullRebuild = false;
  private watcher?: fs.FSWatcher;

  constructor(private readonly plansDirectory: string) {}

  public get plansDirectoryPath(): string {
    return this.plansDirectory;
  }

  public async ensureUpToDate(): Promise<IndexStatus> {
    const directoryExists = await this.refreshDirectoryState();
    if (!directoryExists) {
      this.clearCache();
      return "missing";
    }

    if (!this.cacheWarm || this.forceFullRebuild) {
      await this.rebuildFromDisk();
      return "ready";
    }

    if (this.pendingPaths.size === 0) {
      return "ready";
    }

    try {
      await this.applyPendingDiffs();
    } catch {
      this.forceFullRebuild = true;
      await this.rebuildFromDisk();
    }

    return "ready";
  }

  public getQuickPickItems(): PlanQuickPickItem[] {
    if (!this.quickPickDirty) {
      return this.quickPickItemsCache;
    }

    const items: PlanQuickPickItem[] = [];
    let activeDateKey: string | undefined;

    for (const record of this.sortedRecords) {
      if (record.dateKey !== activeDateKey) {
        items.push({
          label: record.dateLabel,
          kind: vscode.QuickPickItemKind.Separator,
        });
        activeDateKey = record.dateKey;
      }

      items.push({
        label: record.title,
        description: record.timeLabel,
        uri: record.uri,
      });
    }

    this.quickPickItemsCache = items;
    this.quickPickDirty = false;
    return items;
  }

  public dispose(): void {
    this.disposeWatcher();
  }

  private async refreshDirectoryState(): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(this.plansDirectory);
      if (!stat.isDirectory()) {
        this.disposeWatcher();
        return false;
      }

      if (!this.watcher) {
        this.startWatcher();
      }

      return true;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        this.disposeWatcher();
        return false;
      }

      throw error;
    }
  }

  private startWatcher(): void {
    try {
      this.watcher = fs.watch(
        this.plansDirectory,
        { persistent: false, encoding: "utf8" },
        (_eventType, fileName) => {
          if (!fileName) {
            this.forceFullRebuild = true;
            this.quickPickDirty = true;
            return;
          }

          const fileNameString = fileName;

          if (!this.isPlanFileName(fileNameString)) {
            return;
          }

          const fullPath = path.join(this.plansDirectory, fileNameString);
          this.pendingPaths.add(fullPath);
        },
      );

      this.watcher.on("error", () => {
        this.forceFullRebuild = true;
        this.quickPickDirty = true;
        this.disposeWatcher();
      });
    } catch {
      this.forceFullRebuild = true;
      this.quickPickDirty = true;
    }
  }

  private disposeWatcher(): void {
    if (!this.watcher) {
      return;
    }

    this.watcher.close();
    this.watcher = undefined;
  }

  private clearCache(): void {
    this.recordsByPath.clear();
    this.sortedRecords = [];
    this.pendingPaths.clear();
    this.quickPickItemsCache = [];
    this.quickPickDirty = true;
    this.cacheWarm = false;
    this.forceFullRebuild = false;
  }

  private async rebuildFromDisk(): Promise<void> {
    const nextMap = new Map<string, PlanRecord>();
    const nextSortedRecords: PlanRecord[] = [];

    const entries = await fs.promises.readdir(this.plansDirectory, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isFile() || !this.isPlanFileName(entry.name)) {
        continue;
      }

      const fullPath = path.join(this.plansDirectory, entry.name);
      const record = await this.buildRecord(fullPath);
      if (!record) {
        continue;
      }

      nextMap.set(fullPath, record);
      nextSortedRecords.push(record);
    }

    nextSortedRecords.sort(comparePlanRecordsDesc);

    this.recordsByPath.clear();
    for (const [filePath, record] of nextMap.entries()) {
      this.recordsByPath.set(filePath, record);
    }

    this.sortedRecords = nextSortedRecords;
    this.pendingPaths.clear();
    this.cacheWarm = true;
    this.forceFullRebuild = false;
    this.quickPickDirty = true;
  }

  private async applyPendingDiffs(): Promise<void> {
    const changedPaths = Array.from(this.pendingPaths);
    this.pendingPaths.clear();

    for (const changedPath of changedPaths) {
      const updatedRecord = await this.buildRecord(changedPath);
      if (!updatedRecord) {
        this.removePath(changedPath);
        continue;
      }

      const existingRecord = this.recordsByPath.get(changedPath);
      if (
        existingRecord &&
        existingRecord.timestampMs === updatedRecord.timestampMs &&
        existingRecord.size === updatedRecord.size
      ) {
        continue;
      }

      if (existingRecord) {
        this.removePath(changedPath);
      }

      this.insertRecord(updatedRecord);
    }
  }

  private insertRecord(record: PlanRecord): void {
    const insertionIndex = this.findInsertIndex(record);
    this.sortedRecords.splice(insertionIndex, 0, record);
    this.recordsByPath.set(record.filePath, record);
    this.quickPickDirty = true;
  }

  private removePath(filePath: string): void {
    const existingRecord = this.recordsByPath.get(filePath);
    if (!existingRecord) {
      return;
    }

    this.recordsByPath.delete(filePath);
    const existingIndex = this.sortedRecords.findIndex(
      (record) => record.filePath === filePath,
    );

    if (existingIndex >= 0) {
      this.sortedRecords.splice(existingIndex, 1);
    }

    this.quickPickDirty = true;
  }

  private findInsertIndex(record: PlanRecord): number {
    let low = 0;
    let high = this.sortedRecords.length;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const comparison = comparePlanRecordsDesc(record, this.sortedRecords[mid]);

      if (comparison < 0) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }

    return low;
  }

  private async buildRecord(filePath: string): Promise<PlanRecord | undefined> {
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || !this.isPlanFileName(path.basename(filePath))) {
        return undefined;
      }

      const modified = new Date(stat.mtimeMs);
      const title = await extractPlanTitle(filePath);

      return {
        filePath,
        uri: vscode.Uri.file(filePath),
        fileName: path.basename(filePath),
        title,
        timestampMs: stat.mtimeMs,
        size: stat.size,
        dateKey: toLocalDateKey(modified),
        dateLabel: this.dateFormatter.format(modified),
        timeLabel: this.timeFormatter.format(modified),
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  private isPlanFileName(fileName: string): boolean {
    return fileName.endsWith(PLAN_FILE_SUFFIX);
  }
}

function comparePlanRecordsDesc(a: PlanRecord, b: PlanRecord): number {
  if (a.timestampMs !== b.timestampMs) {
    return b.timestampMs - a.timestampMs;
  }

  return a.filePath.localeCompare(b.filePath);
}

function toLocalDateKey(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function extractPlanTitle(filePath: string): Promise<string> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    const lines = content.split("\n");

    // Check for YAML frontmatter
    if (lines[0]?.trim() === "---") {
      let inFrontmatter = true;
      for (let i = 1; i < Math.min(lines.length, 100); i++) {
        const line = lines[i];
        if (line.trim() === "---") {
          inFrontmatter = false;
          break;
        }
        
        // Extract name field from frontmatter
        const nameMatch = line.match(/^name:\s*(.+)$/);
        if (nameMatch && inFrontmatter) {
          return nameMatch[1].trim();
        }
      }
    }

    // Fallback: look for first markdown heading
    for (const line of lines.slice(0, 50)) {
      const headingMatch = line.match(/^#\s+(.+)$/);
      if (headingMatch) {
        return headingMatch[1].trim();
      }
    }

    // Final fallback: use filename without extension
    return path.basename(filePath, PLAN_FILE_SUFFIX);
  } catch {
    return path.basename(filePath, PLAN_FILE_SUFFIX);
  }
}

function resolveHomeDirectory(): string | undefined {
  const homeFromOs = os.homedir();
  if (homeFromOs.trim().length > 0) {
    return homeFromOs;
  }

  const homeFromEnv = process.env.HOME;
  if (homeFromEnv && homeFromEnv.trim().length > 0) {
    return homeFromEnv;
  }

  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const homeDirectory = resolveHomeDirectory();

  if (!homeDirectory) {
    const unavailableCommand = vscode.commands.registerCommand(
      LIST_PLANS_COMMAND_ID,
      () => {
        void vscode.window.showErrorMessage(
          "Unable to resolve your home directory.",
        );
      },
    );

    context.subscriptions.push(unavailableCommand);
    return;
  }

  const planIndex = new PlanIndexCache(
    path.join(homeDirectory, ".cursor", "plans"),
  );

  const commandDisposable = vscode.commands.registerCommand(
    LIST_PLANS_COMMAND_ID,
    async () => {
      const indexStatus = await planIndex.ensureUpToDate();

      if (indexStatus === "missing") {
        void vscode.window.showInformationMessage(
          `No plans directory found at ${planIndex.plansDirectoryPath}.`,
        );
        return;
      }

      const items = planIndex.getQuickPickItems();
      const hasPlans = items.some(
        (item) => item.kind !== vscode.QuickPickItemKind.Separator,
      );

      if (!hasPlans) {
        void vscode.window.showInformationMessage(
          `No plan files found in ${planIndex.plansDirectoryPath}.`,
        );
        return;
      }

      const pickedItem = await vscode.window.showQuickPick(items, {
        title: "Cursor Plans",
        placeHolder: "Select a plan file to open",
        matchOnDescription: true,
        ignoreFocusOut: true,
      });

      if (!pickedItem || !pickedItem.uri) {
        return;
      }

      try {
        await vscode.commands.executeCommand("vscode.open", pickedItem.uri);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred.";
        void vscode.window.showErrorMessage(
          `Unable to open plan file: ${message}`,
        );
      }
    },
  );

  context.subscriptions.push(planIndex, commandDisposable);
}

export function deactivate(): void {}
