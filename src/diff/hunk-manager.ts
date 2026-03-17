import * as vscode from 'vscode';
import { FileDiff, Hunk } from './types';
import { parseDiff, buildPatch } from './diff-parser';
import { GitService } from '../services/git-service';
import { ChangelistManager } from '../models/changelist-manager';

/**
 * Manages hunk-to-changelist assignments.
 * New hunks are auto-assigned to the active changelist.
 * A file can appear in multiple changelists if its hunks are split.
 */
export class HunkManager implements vscode.Disposable {
  /** Map: hunkId → changelistId */
  private assignments: Map<string, string> = new Map();
  /** Cached parsed diffs */
  private fileDiffs: FileDiff[] = [];

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly git: GitService,
    private readonly changelistManager: ChangelistManager,
  ) {}

  /** Re-parse the current git diff, match hunks via fingerprint, auto-assign new ones */
  async refresh(): Promise<void> {
    try {
      const diffOutput = await this.git.getFullDiff();
      const newFileDiffs = parseDiff(diffOutput);

      const newHunkIds = new Set(
        newFileDiffs.flatMap(f => f.hunks.map(h => h.id))
      );

      // Build fingerprint→assignment map from OLD hunks that are disappearing
      // (their IDs changed because context shifted after a commit)
      const fingerprintAssignments = new Map<string, string>();
      for (const [oldId, clId] of this.assignments.entries()) {
        if (!newHunkIds.has(oldId) && this.changelistManager.getById(clId)) {
          // This old hunk ID is gone — find its fingerprint from old diffs
          const oldHunk = this.findHunkById(oldId);
          if (oldHunk) {
            fingerprintAssignments.set(oldHunk.fingerprint, clId);
          }
        }
      }

      // Clean up assignments for IDs that no longer exist or changelists deleted
      for (const [id, clId] of this.assignments.entries()) {
        if (!newHunkIds.has(id) || !this.changelistManager.getById(clId)) {
          this.assignments.delete(id);
        }
      }

      // Assign new hunks: match via fingerprint first, then fallback to active list
      const activeList = this.changelistManager.getActive();
      for (const fileDiff of newFileDiffs) {
        for (const hunk of fileDiff.hunks) {
          if (this.assignments.has(hunk.id)) {
            continue; // Already assigned (ID survived)
          }

          // Try to recover assignment via fingerprint match
          const matchedCl = fingerprintAssignments.get(hunk.fingerprint);
          if (matchedCl) {
            this.assignments.set(hunk.id, matchedCl);
            // Consume this fingerprint so it's not matched twice
            fingerprintAssignments.delete(hunk.fingerprint);
          } else {
            // Truly new hunk — assign to active changelist
            this.assignments.set(hunk.id, activeList.id);
          }
        }
      }

      // Ensure files appear in all changelists that have hunks assigned
      this.syncFileAssignments(newFileDiffs);

      // Remove files from changelists where they have no hunks assigned anymore
      this.cleanupOrphanedFiles(newFileDiffs);

      this.fileDiffs = newFileDiffs;
      this._onDidChange.fire();
    } catch (err) {
      console.error('HunkManager refresh failed:', err);
    }
  }

  /** Get all parsed file diffs */
  getFileDiffs(): readonly FileDiff[] {
    return this.fileDiffs;
  }

  /** Get all hunks for a specific file */
  getHunksForFile(filePath: string): Hunk[] {
    const file = this.fileDiffs.find(f => f.filePath === filePath);
    return file?.hunks ?? [];
  }

  /** Get hunks for a file that are assigned to a specific changelist */
  getHunksForFileInChangelist(filePath: string, changelistId: string): Hunk[] {
    return this.getHunksForFile(filePath).filter(
      h => this.assignments.get(h.id) === changelistId
    );
  }

  /** Get the changelist assignment for a hunk */
  getAssignment(hunkId: string): string | undefined {
    return this.assignments.get(hunkId);
  }

  /** Assign a hunk to a changelist */
  assign(hunkId: string, changelistId: string): void {
    this.assignments.set(hunkId, changelistId);
    // Ensure file is in the target changelist too
    const hunk = this.findHunkById(hunkId);
    if (hunk) {
      const existing = this.changelistManager.findFileChangelist(hunk.filePath);
      if (!existing || existing.id !== changelistId) {
        // Add file to target changelist if not there
        if (!this.changelistManager.getFilesForChangelist(changelistId)
          .some(f => f.relativePath === hunk.filePath)) {
          this.changelistManager.addFileShared(changelistId, hunk.filePath);
        }
      }
    }
    this._onDidChange.fire();
  }

  /** Remove a hunk's changelist assignment */
  unassign(hunkId: string): void {
    this.assignments.delete(hunkId);
    this._onDidChange.fire();
  }

  /** Get all changelist IDs that have hunks for a specific file */
  getChangelistsForFile(filePath: string): string[] {
    const hunks = this.getHunksForFile(filePath);
    const ids = new Set<string>();
    for (const hunk of hunks) {
      const clId = this.assignments.get(hunk.id);
      if (clId) ids.add(clId);
    }
    return [...ids];
  }

  /** Get all hunks assigned to a specific changelist, grouped by file */
  getHunksForChangelist(changelistId: string): Map<string, { fileDiff: FileDiff; hunks: Hunk[] }> {
    const result = new Map<string, { fileDiff: FileDiff; hunks: Hunk[] }>();

    for (const fileDiff of this.fileDiffs) {
      const assignedHunks = fileDiff.hunks.filter(
        h => this.assignments.get(h.id) === changelistId
      );

      if (assignedHunks.length > 0) {
        result.set(fileDiff.filePath, { fileDiff, hunks: assignedHunks });
      }
    }

    return result;
  }

  /**
   * Build patches for all files that have hunks assigned to a changelist.
   */
  buildPatchesForChangelist(changelistId: string): string[] {
    const patches: string[] = [];
    const fileHunks = this.getHunksForChangelist(changelistId);

    for (const [, { fileDiff, hunks }] of fileHunks) {
      const patch = buildPatch(fileDiff, hunks);
      if (patch) {
        patches.push(patch);
      }
    }

    return patches;
  }

  /** After a commit, remove assignments for the committed changelist and refresh */
  async postCommitCleanup(changelistId: string): Promise<void> {
    for (const [hunkId, clId] of this.assignments.entries()) {
      if (clId === changelistId) {
        this.assignments.delete(hunkId);
      }
    }
    await this.refresh();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  // --- Private ---

  private findHunkById(hunkId: string): Hunk | undefined {
    for (const fileDiff of this.fileDiffs) {
      const hunk = fileDiff.hunks.find(h => h.id === hunkId);
      if (hunk) return hunk;
    }
    return undefined;
  }

  /**
   * Ensure that if a file has hunks in multiple changelists,
   * the file appears in all of those changelists at the ChangelistManager level.
   */
  private syncFileAssignments(fileDiffs: FileDiff[]): void {
    for (const fileDiff of fileDiffs) {
      const changelistIds = new Set<string>();
      for (const hunk of fileDiff.hunks) {
        const clId = this.assignments.get(hunk.id);
        if (clId) changelistIds.add(clId);
      }

      // Ensure file is in each changelist that has hunks for it
      for (const clId of changelistIds) {
        // Skip if changelist was deleted
        if (!this.changelistManager.getById(clId)) continue;

        const filesInCl = this.changelistManager.getFilesForChangelist(clId);
        if (!filesInCl.some(f => f.relativePath === fileDiff.filePath)) {
          this.changelistManager.addFileShared(clId, fileDiff.filePath);
        }
      }
    }
  }

  /**
   * Remove files from changelists where they no longer have any hunks assigned.
   * Prevents "ghost" files from lingering after their hunks were committed or moved.
   */
  private cleanupOrphanedFiles(fileDiffs: FileDiff[]): void {
    // Build: for each file, which changelists have hunks assigned?
    const fileToActiveChangelists = new Map<string, Set<string>>();
    for (const fileDiff of fileDiffs) {
      const clIds = new Set<string>();
      for (const hunk of fileDiff.hunks) {
        const clId = this.assignments.get(hunk.id);
        if (clId) clIds.add(clId);
      }
      fileToActiveChangelists.set(fileDiff.filePath, clIds);
    }

    // For each changelist, remove files that have no hunks in it
    for (const cl of this.changelistManager.getAll()) {
      for (const file of cl.files) {
        const activeClIds = fileToActiveChangelists.get(file.relativePath);
        if (activeClIds && !activeClIds.has(cl.id)) {
          // File has hunks but none in this changelist → remove
          this.changelistManager.removeFile(cl.id, file.relativePath);
        }
      }
    }
  }
}
