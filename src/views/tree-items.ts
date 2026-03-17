import * as vscode from 'vscode';
import { Changelist, ChangelistFile } from '../models/types';
import { Hunk } from '../diff/types';

export class ChangelistTreeItem extends vscode.TreeItem {
  constructor(public readonly changelist: Changelist) {
    super(changelist.name, vscode.TreeItemCollapsibleState.Expanded);

    this.id = `changelist:${changelist.id}`;
    this.contextValue = changelist.isDefault ? 'changelist-default' : 'changelist';
    this.description = `${changelist.files.length} file${changelist.files.length !== 1 ? 's' : ''}`;

    if (changelist.isActive) {
      this.iconPath = new vscode.ThemeIcon('pass-filled');
      this.description = `${this.description} — active`;
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-large-outline');
    }

    this.command = {
      command: 'changelists.setActiveChangelist',
      title: 'Set Active',
      arguments: [this],
    };
  }
}

export class FileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly file: ChangelistFile,
    public readonly changelistId: string,
    workspaceRoot: string,
    hasHunks: boolean,
  ) {
    const fileName = file.relativePath.split('/').pop() ?? file.relativePath;
    super(
      fileName,
      hasHunks
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    this.id = `file:${changelistId}:${file.relativePath}`;
    this.contextValue = 'changelistFile';
    this.description = file.relativePath.includes('/')
      ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/'))
      : '';
    this.tooltip = file.relativePath;
    this.resourceUri = vscode.Uri.file(`${workspaceRoot}/${file.relativePath}`);

    if (!hasHunks) {
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [this.resourceUri],
      };
    }

    this.iconPath = vscode.ThemeIcon.File;
  }
}

export class HunkTreeItem extends vscode.TreeItem {
  constructor(
    public readonly hunk: Hunk,
    public readonly changelistId: string,
  ) {
    super(
      `L${hunk.newStart}: ${hunk.summary}`,
      vscode.TreeItemCollapsibleState.None,
    );

    this.id = `hunk:${changelistId}:${hunk.id}`;
    this.contextValue = 'changelistHunk';
    this.description = `+${countLines(hunk.content, '+')} / -${countLines(hunk.content, '-')}`;
    this.tooltip = `Lines ${hunk.newStart}–${hunk.newStart + hunk.newLines - 1}\n${hunk.summary}`;
    this.iconPath = new vscode.ThemeIcon('diff');
  }
}

function countLines(content: string, prefix: string): number {
  return content.split('\n').filter(l => l.startsWith(prefix) && !l.startsWith(prefix.repeat(3))).length;
}

export type ChangelistTreeNode = ChangelistTreeItem | FileTreeItem | HunkTreeItem;
