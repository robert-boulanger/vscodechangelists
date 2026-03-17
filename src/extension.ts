import * as vscode from 'vscode';
import { ChangelistManager } from './models/changelist-manager';
import { GitService } from './services/git-service';
import { FileTracker } from './services/file-tracker';
import { HunkManager } from './diff/hunk-manager';
import { buildPatch } from './diff/diff-parser';
import { ChangelistTreeDataProvider } from './views/tree-data-provider';
import { ChangelistTreeItem, FileTreeItem } from './views/tree-items';
import type { TicketProvider } from './tickets/types';
import { JiraTicketProvider } from './tickets/jira-provider';
import { GitHubTicketProvider } from './tickets/github-provider';
import { showTicketPicker } from './tickets/ticket-picker';

let manager: ChangelistManager | undefined;
let fileTracker: FileTracker | undefined;
let hunkManager: HunkManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const git = new GitService(workspaceRoot);

  manager = new ChangelistManager();
  hunkManager = new HunkManager(git, manager);

  const treeProvider = new ChangelistTreeDataProvider(manager, hunkManager, workspaceRoot);

  const treeView = vscode.window.createTreeView('changelists.view', {
    treeDataProvider: treeProvider,
    dragAndDropController: treeProvider,
    canSelectMany: true,
  });

  // Initialize (loads persisted state)
  void manager.initialize(workspaceFolder.uri);

  // --- Git Integration & File Tracking ---

  const config = vscode.workspace.getConfiguration('changelists');
  const pollInterval = config.get<number>('pollInterval', 3000);

  fileTracker = new FileTracker(manager, git, pollInterval);
  fileTracker.start();

  // Refresh hunks when file tracker scans
  const origScan = fileTracker.scan.bind(fileTracker);
  fileTracker.scan = async () => {
    await origScan();
    await hunkManager?.refresh();
  };

  // Initial hunk refresh
  void hunkManager.refresh();

  // --- Commands ---

  // --- Ticket Provider ---

  const newChangelist = vscode.commands.registerCommand(
    'changelists.newChangelist',
    async () => {
      let name: string | undefined;

      // Re-evaluate provider each time (settings may have changed)
      const ticketProvider = createTicketProvider();
      if (ticketProvider) {
        name = await showTicketPicker(ticketProvider);
      } else {
        name = await vscode.window.showInputBox({
          prompt: 'Enter changelist name',
          placeHolder: 'e.g. Feature: User Authentication',
          validateInput: (value) => {
            if (!value.trim()) {
              return 'Name cannot be empty';
            }
            return undefined;
          },
        });
      }

      if (name && manager) {
        try {
          const cl = manager.create(name);
          manager.setActive(cl.id);
        } catch (err) {
          vscode.window.showErrorMessage(`${err}`);
        }
      }
    }
  );

  const deleteChangelist = vscode.commands.registerCommand(
    'changelists.deleteChangelist',
    async (item?: ChangelistTreeItem) => {
      if (!manager) return;

      let id: string | undefined;
      if (item) {
        id = item.changelist.id;
      } else {
        const choices = manager.getAll()
          .filter(cl => !cl.isDefault)
          .map(cl => ({ label: cl.name, id: cl.id }));

        if (choices.length === 0) {
          vscode.window.showInformationMessage('No changelists to delete');
          return;
        }

        const picked = await vscode.window.showQuickPick(choices, {
          placeHolder: 'Select changelist to delete',
        });
        id = picked?.id;
      }

      if (id) {
        try {
          manager.delete(id);
        } catch (err) {
          vscode.window.showErrorMessage(`${err}`);
        }
      }
    }
  );

  const renameChangelist = vscode.commands.registerCommand(
    'changelists.renameChangelist',
    async (item?: ChangelistTreeItem) => {
      if (!manager) return;

      let id: string | undefined;
      let currentName: string | undefined;

      if (item) {
        id = item.changelist.id;
        currentName = item.changelist.name;
      } else {
        const choices = manager.getAll().map(cl => ({ label: cl.name, id: cl.id }));
        const picked = await vscode.window.showQuickPick(choices, {
          placeHolder: 'Select changelist to rename',
        });
        if (picked) {
          id = picked.id;
          currentName = picked.label;
        }
      }

      if (id) {
        const newName = await vscode.window.showInputBox({
          prompt: 'Enter new name',
          value: currentName,
          validateInput: (value) => {
            if (!value.trim()) return 'Name cannot be empty';
            return undefined;
          },
        });
        if (newName) {
          try {
            manager.rename(id, newName);
          } catch (err) {
            vscode.window.showErrorMessage(`${err}`);
          }
        }
      }
    }
  );

  const setActiveChangelist = vscode.commands.registerCommand(
    'changelists.setActiveChangelist',
    async (item?: ChangelistTreeItem) => {
      if (!manager) return;

      let id: string | undefined;

      if (item) {
        id = item.changelist.id;
      } else {
        const choices = manager.getAll().map(cl => ({
          label: `${cl.isActive ? '$(pass-filled) ' : ''}${cl.name}`,
          id: cl.id,
        }));
        const picked = await vscode.window.showQuickPick(choices, {
          placeHolder: 'Select active changelist',
        });
        id = picked?.id;
      }

      if (id) {
        manager.setActive(id);
      }
    }
  );

  const moveFileTo = vscode.commands.registerCommand(
    'changelists.moveFileTo',
    async (item?: FileTreeItem) => {
      if (!manager || !item) return;

      const choices = manager.getAll()
        .filter(cl => cl.id !== item.changelistId)
        .map(cl => ({ label: cl.name, id: cl.id }));

      if (choices.length === 0) {
        vscode.window.showInformationMessage('No other changelists available');
        return;
      }

      const picked = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Move file to changelist...',
      });

      if (picked) {
        manager.moveFile(item.file.relativePath, item.changelistId, picked.id);
      }
    }
  );

  const removeFile = vscode.commands.registerCommand(
    'changelists.removeFile',
    (item?: FileTreeItem) => {
      if (!manager || !item) return;
      manager.removeFile(item.changelistId, item.file.relativePath);
    }
  );

  const openFile = vscode.commands.registerCommand(
    'changelists.openFile',
    (item?: FileTreeItem) => {
      if (!item?.resourceUri) return;
      void vscode.commands.executeCommand('vscode.open', item.resourceUri);
    }
  );

  const openDiff = vscode.commands.registerCommand(
    'changelists.openDiff',
    (item?: FileTreeItem) => {
      if (!item?.resourceUri) return;
      void vscode.commands.executeCommand('git.openChange', item.resourceUri);
    }
  );

  const commitChangelist = vscode.commands.registerCommand(
    'changelists.commitChangelist',
    async (item?: ChangelistTreeItem) => {
      if (!manager) return;
      const cl = item?.changelist ?? manager.getActive();

      if (cl.files.length === 0) {
        vscode.window.showWarningMessage(`Changelist "${cl.name}" has no files to commit`);
        return;
      }

      const message = await vscode.window.showInputBox({
        prompt: `Commit message for "${cl.name}"`,
        value: cl.isDefault ? '' : cl.name,
        validateInput: (v) => v.trim() ? undefined : 'Commit message cannot be empty',
      });

      if (!message) return;

      try {
        // 1. Reset index to clean state
        await git.unstageAll();

        // 2. Refresh hunk data to get latest state
        await hunkManager?.refresh();

        // 3. Stage files — per-file decision: hunk-level or whole-file
        const hunkFilesForThisCl = hunkManager?.getHunksForChangelist(cl.id);
        let stagedCount = 0;

        for (const file of cl.files) {
          const clHunks = hunkFilesForThisCl?.get(file.relativePath);

          if (clHunks && clHunks.hunks.length > 0 && hunkManager) {
            // This file has hunks assigned to this changelist → patch staging
            const patch = buildPatch(clHunks.fileDiff, clHunks.hunks);
            if (patch) {
              await git.applyPatch(patch);
              stagedCount++;
            }
          } else if (hunkManager) {
            // Check if this file has hunks in OTHER changelists
            const allHunks = hunkManager.getHunksForFile(file.relativePath);
            if (allHunks.length === 0) {
              // No hunks at all (new file, binary, etc.) → stage whole file
              await git.stageFiles([file.relativePath]);
              stagedCount++;
            }
            // else: file has hunks in other changelists but not this one → skip
          } else {
            // No HunkManager → simple file-level staging
            await git.stageFiles([file.relativePath]);
            stagedCount++;
          }
        }

        if (stagedCount === 0) {
          vscode.window.showWarningMessage(
            `No changes to commit for "${cl.name}" — hunks may have been moved to other changelists`
          );
          return;
        }

        // 4. Commit
        await git.commit(message);

        // 5. Cleanup
        if (hunkManager) {
          await hunkManager.postCommitCleanup(cl.id);
        }

        // Remove committed files from changelist (only fully committed ones)
        const remainingDirty = await git.getDirtyFilePaths();
        const committedPaths = cl.files
          .filter(f => !remainingDirty.has(f.relativePath))
          .map(f => f.relativePath);

        for (const path of committedPaths) {
          manager.removeFile(cl.id, path);
        }

        // 5. Optionally remove empty changelist
        const removeEmpty = vscode.workspace
          .getConfiguration('changelists')
          .get<boolean>('removeEmptyChangelistAfterCommit', false);

        if (removeEmpty && !cl.isDefault && cl.files.length === 0) {
          manager.delete(cl.id);
        }

        vscode.window.showInformationMessage(
          `Committed: "${message}"`
        );

        // 6. Refresh tracking
        await fileTracker?.scan();
      } catch (err) {
        vscode.window.showErrorMessage(`Commit failed: ${err}`);
      }
    }
  );

  // --- StatusBar ---

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'changelists.setActiveChangelist';
  updateStatusBar(statusBar, manager);

  manager.onDidChangeActiveList(() => {
    if (manager) updateStatusBar(statusBar, manager);
  });
  manager.onDidChange(() => {
    if (manager) updateStatusBar(statusBar, manager);
  });

  statusBar.show();

  // --- Register all ---

  context.subscriptions.push(
    treeView,
    treeProvider,
    fileTracker,
    hunkManager,
    statusBar,
    newChangelist,
    deleteChangelist,
    renameChangelist,
    setActiveChangelist,
    moveFileTo,
    removeFile,
    openFile,
    openDiff,
    commitChangelist,
  );
}

export function deactivate(): void {
  fileTracker?.dispose();
  fileTracker = undefined;
  hunkManager?.dispose();
  hunkManager = undefined;
  manager?.dispose();
  manager = undefined;
}

function updateStatusBar(statusBar: vscode.StatusBarItem, mgr: ChangelistManager): void {
  const active = mgr.getActive();
  statusBar.text = `$(list-tree) ${active.name}`;
  statusBar.tooltip = `Active Changelist: ${active.name} (click to change)`;
}

function createTicketProvider(): TicketProvider | undefined {
  const config = vscode.workspace.getConfiguration('changelists');
  const provider = config.get<string>('ticketProvider', 'none');

  switch (provider) {
    case 'jira':
      return new JiraTicketProvider();
    case 'github':
      return new GitHubTicketProvider();
    default:
      return undefined;
  }
}
