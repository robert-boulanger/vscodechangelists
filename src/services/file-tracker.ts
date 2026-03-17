import * as vscode from 'vscode';
import { ChangelistManager } from '../models/changelist-manager';
import { GitService } from './git-service';

export class FileTracker implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposables: vscode.Disposable[] = [];
  private isRunning = false;

  constructor(
    private readonly manager: ChangelistManager,
    private readonly git: GitService,
    private readonly pollIntervalMs: number,
  ) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Immediate first scan
    void this.scan();

    // Poll for git changes
    this.timer = setInterval(() => void this.scan(), this.pollIntervalMs);

    // Also react to file save events for faster response
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(() => {
        void this.scan();
      })
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.isRunning = false;
  }

  /** Force an immediate scan */
  async scan(): Promise<void> {
    try {
      const dirtyPaths = await this.git.getDirtyFilePaths();

      // 1. Assign new dirty files to the active changelist
      const config = vscode.workspace.getConfiguration('changelists');
      const autoTrack = config.get<boolean>('autoTrackChanges', true);

      if (autoTrack) {
        for (const path of dirtyPaths) {
          const existing = this.manager.findFileChangelist(path);
          if (!existing) {
            const active = this.manager.getActive();
            this.manager.addFile(active.id, path);
          }
        }
      }

      // 2. Remove files that are no longer dirty
      this.manager.removeCleanFiles(dirtyPaths);
    } catch (error) {
      // Git command failed (e.g., not a git repo) — silently skip
      console.error('FileTracker scan failed:', error);
    }
  }

  dispose(): void {
    this.stop();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
