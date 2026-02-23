"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const LIST_PLANS_COMMAND_ID = "cursorPlans.listPlans";
const PLAN_FILE_SUFFIX = ".plan.md";
class PlanIndexCache {
    constructor(plansDirectory) {
        this.plansDirectory = plansDirectory;
        this.recordsByPath = new Map();
        this.dateFormatter = new Intl.DateTimeFormat(undefined, {
            weekday: "short",
            year: "numeric",
            month: "short",
            day: "numeric",
        });
        this.timeFormatter = new Intl.DateTimeFormat(undefined, {
            hour: "numeric",
            minute: "2-digit",
        });
        this.sortedRecords = [];
        this.pendingPaths = new Set();
        this.quickPickItemsCache = [];
        this.quickPickDirty = true;
        this.cacheWarm = false;
        this.forceFullRebuild = false;
    }
    get plansDirectoryPath() {
        return this.plansDirectory;
    }
    async ensureUpToDate() {
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
        }
        catch {
            this.forceFullRebuild = true;
            await this.rebuildFromDisk();
        }
        return "ready";
    }
    getQuickPickItems() {
        if (!this.quickPickDirty) {
            return this.quickPickItemsCache;
        }
        const items = [];
        let activeDateKey;
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
    dispose() {
        this.disposeWatcher();
    }
    async refreshDirectoryState() {
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
        }
        catch (error) {
            const nodeError = error;
            if (nodeError.code === "ENOENT") {
                this.disposeWatcher();
                return false;
            }
            throw error;
        }
    }
    startWatcher() {
        try {
            this.watcher = fs.watch(this.plansDirectory, { persistent: false, encoding: "utf8" }, (_eventType, fileName) => {
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
            });
            this.watcher.on("error", () => {
                this.forceFullRebuild = true;
                this.quickPickDirty = true;
                this.disposeWatcher();
            });
        }
        catch {
            this.forceFullRebuild = true;
            this.quickPickDirty = true;
        }
    }
    disposeWatcher() {
        if (!this.watcher) {
            return;
        }
        this.watcher.close();
        this.watcher = undefined;
    }
    clearCache() {
        this.recordsByPath.clear();
        this.sortedRecords = [];
        this.pendingPaths.clear();
        this.quickPickItemsCache = [];
        this.quickPickDirty = true;
        this.cacheWarm = false;
        this.forceFullRebuild = false;
    }
    async rebuildFromDisk() {
        const nextMap = new Map();
        const nextSortedRecords = [];
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
    async applyPendingDiffs() {
        const changedPaths = Array.from(this.pendingPaths);
        this.pendingPaths.clear();
        for (const changedPath of changedPaths) {
            const updatedRecord = await this.buildRecord(changedPath);
            if (!updatedRecord) {
                this.removePath(changedPath);
                continue;
            }
            const existingRecord = this.recordsByPath.get(changedPath);
            if (existingRecord &&
                existingRecord.timestampMs === updatedRecord.timestampMs &&
                existingRecord.size === updatedRecord.size) {
                continue;
            }
            if (existingRecord) {
                this.removePath(changedPath);
            }
            this.insertRecord(updatedRecord);
        }
    }
    insertRecord(record) {
        const insertionIndex = this.findInsertIndex(record);
        this.sortedRecords.splice(insertionIndex, 0, record);
        this.recordsByPath.set(record.filePath, record);
        this.quickPickDirty = true;
    }
    removePath(filePath) {
        const existingRecord = this.recordsByPath.get(filePath);
        if (!existingRecord) {
            return;
        }
        this.recordsByPath.delete(filePath);
        const existingIndex = this.sortedRecords.findIndex((record) => record.filePath === filePath);
        if (existingIndex >= 0) {
            this.sortedRecords.splice(existingIndex, 1);
        }
        this.quickPickDirty = true;
    }
    findInsertIndex(record) {
        let low = 0;
        let high = this.sortedRecords.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            const comparison = comparePlanRecordsDesc(record, this.sortedRecords[mid]);
            if (comparison < 0) {
                high = mid;
            }
            else {
                low = mid + 1;
            }
        }
        return low;
    }
    async buildRecord(filePath) {
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
        }
        catch (error) {
            const nodeError = error;
            if (nodeError.code === "ENOENT") {
                return undefined;
            }
            throw error;
        }
    }
    isPlanFileName(fileName) {
        return fileName.endsWith(PLAN_FILE_SUFFIX);
    }
}
function comparePlanRecordsDesc(a, b) {
    if (a.timestampMs !== b.timestampMs) {
        return b.timestampMs - a.timestampMs;
    }
    return a.filePath.localeCompare(b.filePath);
}
function toLocalDateKey(date) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
async function extractPlanTitle(filePath) {
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
    }
    catch {
        return path.basename(filePath, PLAN_FILE_SUFFIX);
    }
}
function resolveHomeDirectory() {
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
function activate(context) {
    const homeDirectory = resolveHomeDirectory();
    if (!homeDirectory) {
        const unavailableCommand = vscode.commands.registerCommand(LIST_PLANS_COMMAND_ID, () => {
            void vscode.window.showErrorMessage("Unable to resolve your home directory.");
        });
        context.subscriptions.push(unavailableCommand);
        return;
    }
    const planIndex = new PlanIndexCache(path.join(homeDirectory, ".cursor", "plans"));
    const commandDisposable = vscode.commands.registerCommand(LIST_PLANS_COMMAND_ID, async () => {
        const indexStatus = await planIndex.ensureUpToDate();
        if (indexStatus === "missing") {
            void vscode.window.showInformationMessage(`No plans directory found at ${planIndex.plansDirectoryPath}.`);
            return;
        }
        const items = planIndex.getQuickPickItems();
        const hasPlans = items.some((item) => item.kind !== vscode.QuickPickItemKind.Separator);
        if (!hasPlans) {
            void vscode.window.showInformationMessage(`No plan files found in ${planIndex.plansDirectoryPath}.`);
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
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error occurred.";
            void vscode.window.showErrorMessage(`Unable to open plan file: ${message}`);
        }
    });
    context.subscriptions.push(planIndex, commandDisposable);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map