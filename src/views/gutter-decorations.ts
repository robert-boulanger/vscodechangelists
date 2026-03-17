import * as vscode from 'vscode';
import { HunkManager } from '../diff/hunk-manager';
import { ChangelistManager } from '../models/changelist-manager';

const CHANGELIST_COLORS = [
  '#4CAF50', // green
  '#2196F3', // blue
  '#FF9800', // orange
  '#9C27B0', // purple
  '#F44336', // red
  '#00BCD4', // cyan
  '#FFEB3B', // yellow
  '#795548', // brown
  '#E91E63', // pink
  '#607D8B', // blue-grey
];

/**
 * Manages colored gutter decorations per changelist.
 * Each changelist gets a unique color bar in the gutter next to changed lines.
 */
export class GutterDecorationManager implements vscode.Disposable {
  private decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
  private colorAssignments: Map<string, string> = new Map();
  private colorIndex = 0;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly hunkManager: HunkManager,
    private readonly changelistManager: ChangelistManager,
  ) {
    // Update decorations when hunks or editors change
    this.disposables.push(
      hunkManager.onDidChange(() => this.updateAllEditors()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateAllEditors()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.updateAllEditors()),
    );
  }

  updateAllEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.updateEditor(editor);
    }
  }

  private updateEditor(editor: vscode.TextEditor): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const filePath = editor.document.uri.fsPath;
    const workspaceRoot = workspaceFolder.uri.fsPath;

    if (!filePath.startsWith(workspaceRoot)) return;

    const relativePath = filePath.slice(workspaceRoot.length + 1);
    const hunks = this.hunkManager.getHunksForFile(relativePath);

    // Collect ranges per changelist
    const rangesByChangelist = new Map<string, vscode.Range[]>();

    for (const hunk of hunks) {
      const clId = this.hunkManager.getAssignment(hunk.id);
      if (!clId) continue;

      const ranges = rangesByChangelist.get(clId) ?? [];

      // Mark the changed lines (newStart is 1-based, VSCode is 0-based)
      const startLine = hunk.newStart - 1;
      const endLine = startLine + hunk.newLines - 1;

      // Only mark actual +/- lines, not context
      const contentLines = hunk.content.split('\n');
      let lineOffset = 0;
      for (const line of contentLines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          ranges.push(new vscode.Range(startLine + lineOffset, 0, startLine + lineOffset, 0));
        }
        if (!line.startsWith('-') && !line.startsWith('---')) {
          lineOffset++;
        }
      }

      rangesByChangelist.set(clId, ranges);
    }

    // Clear all decorations first
    for (const [, decType] of this.decorationTypes) {
      editor.setDecorations(decType, []);
    }

    // Apply decorations per changelist
    for (const [clId, ranges] of rangesByChangelist) {
      const decType = this.getOrCreateDecorationType(clId);
      editor.setDecorations(decType, ranges);
    }
  }

  private getOrCreateDecorationType(changelistId: string): vscode.TextEditorDecorationType {
    let decType = this.decorationTypes.get(changelistId);
    if (decType) return decType;

    const color = this.getColorForChangelist(changelistId);
    const cl = this.changelistManager.getById(changelistId);

    const svgUri = createGutterSvg(color);

    decType = vscode.window.createTextEditorDecorationType({
      isWholeLine: false,
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconPath: svgUri,
      gutterIconSize: '100%',
    });

    this.decorationTypes.set(changelistId, decType);
    return decType;
  }

  private getColorForChangelist(changelistId: string): string {
    let color = this.colorAssignments.get(changelistId);
    if (color) return color;

    // Default changelist gets a neutral color
    const cl = this.changelistManager.getById(changelistId);
    if (cl?.isDefault) {
      color = '#888888';
    } else {
      color = CHANGELIST_COLORS[this.colorIndex % CHANGELIST_COLORS.length];
      this.colorIndex++;
    }

    this.colorAssignments.set(changelistId, color);
    return color;
  }

  dispose(): void {
    for (const [, decType] of this.decorationTypes) {
      decType.dispose();
    }
    this.decorationTypes.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function createGutterSvg(color: string): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="16"><rect x="1" y="0" width="4" height="16" rx="1" fill="${color}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}
