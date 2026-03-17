import * as vscode from 'vscode';
import { ChangelistManager } from '../models/changelist-manager';
import { HunkManager } from '../diff/hunk-manager';
import {
  ChangelistTreeItem,
  ChangelistTreeNode,
  FileTreeItem,
  HunkTreeItem,
} from './tree-items';

const MIME_TYPE = 'application/vnd.changelist.item';

export class ChangelistTreeDataProvider
  implements vscode.TreeDataProvider<ChangelistTreeNode>, vscode.TreeDragAndDropController<ChangelistTreeNode>
{
  readonly dropMimeTypes = [MIME_TYPE];
  readonly dragMimeTypes = [MIME_TYPE];

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ChangelistTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly manager: ChangelistManager,
    private readonly hunkManager: HunkManager | undefined,
    private readonly workspaceRoot: string,
  ) {
    manager.onDidChange(() => this.refresh());
    hunkManager?.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // --- TreeDataProvider ---

  getTreeItem(element: ChangelistTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ChangelistTreeNode): ChangelistTreeNode[] {
    if (!element) {
      return this.manager.getAll().map(cl => new ChangelistTreeItem(cl));
    }

    if (element instanceof ChangelistTreeItem) {
      return element.changelist.files.map(file => {
        const hasHunks = this.fileHasHunks(file.relativePath, element.changelist.id);
        return new FileTreeItem(file, element.changelist.id, this.workspaceRoot, hasHunks);
      });
    }

    if (element instanceof FileTreeItem && this.hunkManager) {
      const hunks = this.hunkManager.getHunksForFileInChangelist(
        element.file.relativePath,
        element.changelistId,
      );
      return hunks.map(h => new HunkTreeItem(h, element.changelistId));
    }

    return [];
  }

  getParent(element: ChangelistTreeNode): ChangelistTreeNode | undefined {
    if (element instanceof FileTreeItem) {
      const cl = this.manager.getById(element.changelistId);
      if (cl) {
        return new ChangelistTreeItem(cl);
      }
    }
    if (element instanceof HunkTreeItem) {
      const cl = this.manager.getById(element.changelistId);
      if (cl) {
        const file = cl.files.find(f => f.relativePath === element.hunk.filePath);
        if (file) {
          const hasHunks = this.fileHasHunks(file.relativePath, element.changelistId);
          return new FileTreeItem(file, element.changelistId, this.workspaceRoot, hasHunks);
        }
      }
    }
    return undefined;
  }

  // --- Drag and Drop ---

  handleDrag(
    source: readonly ChangelistTreeNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const payload: DragPayload[] = [];

    for (const item of source) {
      if (item instanceof FileTreeItem) {
        payload.push({
          type: 'file',
          relativePath: item.file.relativePath,
          changelistId: item.changelistId,
        });
      } else if (item instanceof HunkTreeItem) {
        payload.push({
          type: 'hunk',
          hunkId: item.hunk.id,
          filePath: item.hunk.filePath,
          changelistId: item.changelistId,
        });
      }
    }

    if (payload.length > 0) {
      dataTransfer.set(MIME_TYPE, new vscode.DataTransferItem(JSON.stringify(payload)));
    }
  }

  async handleDrop(
    target: ChangelistTreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    if (!target) return;

    // Determine target changelist
    let targetChangelistId: string;
    if (target instanceof ChangelistTreeItem) {
      targetChangelistId = target.changelist.id;
    } else if (target instanceof FileTreeItem) {
      targetChangelistId = target.changelistId;
    } else if (target instanceof HunkTreeItem) {
      targetChangelistId = target.changelistId;
    } else {
      return;
    }

    const raw = dataTransfer.get(MIME_TYPE);
    if (!raw) return;

    try {
      // DataTransferItem.value can be a string or need async resolution
      let value = raw.value;
      if (typeof value !== 'string') {
        value = await raw.asString();
      }

      const items: DragPayload[] = JSON.parse(value as string);

      for (const item of items) {
        if (item.changelistId === targetChangelistId) continue;

        if (item.type === 'file') {
          // Move file AND its hunk assignments
          this.manager.moveFile(item.relativePath!, item.changelistId, targetChangelistId);

          // Also reassign all hunks of this file
          if (this.hunkManager) {
            const hunks = this.hunkManager.getHunksForFile(item.relativePath!);
            for (const hunk of hunks) {
              if (this.hunkManager.getAssignment(hunk.id) === item.changelistId) {
                this.hunkManager.assign(hunk.id, targetChangelistId);
              }
            }
          }
        } else if (item.type === 'hunk' && this.hunkManager) {
          this.hunkManager.assign(item.hunkId!, targetChangelistId);
        }
      }
    } catch (err) {
      console.error('Drop failed:', err);
    }
  }

  // --- Helpers ---

  private fileHasHunks(filePath: string, changelistId: string): boolean {
    if (!this.hunkManager) return false;
    const hunks = this.hunkManager.getHunksForFileInChangelist(filePath, changelistId);
    return hunks.length > 0;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

interface DragPayload {
  type: 'file' | 'hunk';
  relativePath?: string;
  hunkId?: string;
  filePath?: string;
  changelistId: string;
}
