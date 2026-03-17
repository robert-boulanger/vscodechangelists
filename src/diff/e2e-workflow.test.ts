import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GitService } from '../services/git-service';
import { ChangelistManager } from '../models/changelist-manager';
import { HunkManager } from './hunk-manager';
import { buildPatch } from './diff-parser';

/**
 * Full E2E integration test:
 * Real git repo, real commits, real hunk-level splitting.
 * No Extension Host needed.
 */
describe('E2E Changelist Workflow', () => {
  let testDir: string;
  let git: GitService;
  let manager: ChangelistManager;
  let hunkMgr: HunkManager;

  function run(args: string[]): string {
    return execFileSync('git', args, { cwd: testDir, encoding: 'utf-8' });
  }

  function gitLog(): string[] {
    return run(['log', '--oneline', '--reverse']).trim().split('\n');
  }

  function gitShowFiles(ref: string): string {
    return run(['diff-tree', '--no-commit-id', '-r', '--name-only', ref]).trim();
  }

  function gitShowDiff(ref: string): string {
    return run(['show', '--format=', ref]);
  }

  /** Write a file with numbered lines, optionally inserting text at specific lines */
  function writeTestFile(
    name: string,
    totalLines: number,
    insertions: Map<number, string> = new Map(),
  ): void {
    const lines: string[] = [];
    for (let i = 1; i <= totalLines; i++) {
      if (insertions.has(i)) {
        lines.push(insertions.get(i)!);
      }
      lines.push(`${name}-line-${i}`);
    }
    writeFileSync(join(testDir, name), lines.join('\n') + '\n');
  }

  /** Modify a specific line in a file */
  function modifyLine(name: string, lineNum: number, newContent: string): void {
    const content = readFileSync(join(testDir, name), 'utf-8');
    const lines = content.split('\n');
    lines[lineNum - 1] = newContent;
    writeFileSync(join(testDir, name), lines.join('\n'));
  }

  /** Commit a changelist using the same logic as the extension */
  async function commitChangelist(clId: string, message: string): Promise<void> {
    const cl = manager.getById(clId);
    if (!cl || cl.files.length === 0) {
      throw new Error(`Changelist ${clId} is empty or not found`);
    }

    try { await git.unstageAll(); } catch { /* ok on first commit */ }
    await hunkMgr.refresh();

    const hunkFiles = hunkMgr.getHunksForChangelist(clId);

    for (const file of cl.files) {
      const clHunks = hunkFiles.get(file.relativePath);

      if (clHunks && clHunks.hunks.length > 0) {
        const patch = buildPatch(clHunks.fileDiff, clHunks.hunks);
        if (patch) {
          await git.applyPatch(patch);
        }
      } else {
        const allHunks = hunkMgr.getHunksForFile(file.relativePath);
        if (allHunks.length === 0) {
          await git.stageFiles([file.relativePath]);
        }
      }
    }

    await git.commit(message);
    await hunkMgr.postCommitCleanup(clId);

    // Remove fully committed files
    const dirty = await git.getDirtyFilePaths();
    for (const file of [...cl.files]) {
      if (!dirty.has(file.relativePath)) {
        manager.removeFile(clId, file.relativePath);
      }
    }
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'e2e-changelist-'));
    run(['init']);
    run(['config', 'user.email', 'test@test.com']);
    run(['config', 'user.name', 'Test']);

    // Create initial files with 100 lines each
    writeTestFile('a.txt', 100);
    writeTestFile('b.txt', 100);
    run(['add', '.']);
    run(['commit', '-m', 'initial']);

    git = new GitService(testDir);
    manager = new ChangelistManager();
    hunkMgr = new HunkManager(git, manager);
  });

  afterEach(() => {
    hunkMgr.dispose();
    manager.dispose();
    rmSync(testDir, { recursive: true, force: true });
  });

  // =====================================================
  // TEST 1: Basic file-level changelists
  // =====================================================
  it('should commit different files from different changelists', async () => {
    const feature1 = manager.create('Feature1');
    const feature2 = manager.create('Feature2');

    // Change a.txt while Feature1 is active → hunk auto-assigned to Feature1
    manager.setActive(feature1.id);
    modifyLine('a.txt', 10, 'FEATURE1-CHANGE');
    manager.addFileShared(feature1.id, 'a.txt');
    await hunkMgr.refresh();

    // Change b.txt while Feature2 is active → hunk auto-assigned to Feature2
    manager.setActive(feature2.id);
    modifyLine('b.txt', 10, 'FEATURE2-CHANGE');
    manager.addFileShared(feature2.id, 'b.txt');
    await hunkMgr.refresh();

    // Commit Feature1
    await commitChangelist(feature1.id, 'feat: feature1');

    // Verify only a.txt in this commit
    const log1 = gitShowDiff('HEAD');
    expect(log1).toContain('FEATURE1-CHANGE');
    expect(log1).not.toContain('FEATURE2-CHANGE');

    // b.txt should still be dirty
    const dirty = await git.getDirtyFilePaths();
    expect(dirty.has('b.txt')).toBe(true);
    expect(dirty.has('a.txt')).toBe(false);

    // Commit Feature2
    await commitChangelist(feature2.id, 'feat: feature2');

    const log2 = gitShowDiff('HEAD');
    expect(log2).toContain('FEATURE2-CHANGE');
    expect(log2).not.toContain('FEATURE1-CHANGE');
  });

  // =====================================================
  // TEST 2: Hunk-level — same file, different changelists
  // =====================================================
  it('should commit different hunks of the same file independently', async () => {
    const f1 = manager.create('F1');
    const f2 = manager.create('F2');
    manager.setActive(f1.id);

    // Make two distant changes in a.txt
    modifyLine('a.txt', 10, 'CHANGE-FOR-F1');
    modifyLine('a.txt', 80, 'CHANGE-FOR-F2');

    // Let hunkManager detect them (all go to active=F1 initially)
    manager.addFileShared(f1.id, 'a.txt');
    await hunkMgr.refresh();

    // Find the hunks
    const hunks = hunkMgr.getHunksForFile('a.txt');
    expect(hunks.length).toBeGreaterThanOrEqual(2);

    const hunkF1 = hunks.find(h => h.summary.includes('CHANGE-FOR-F1'));
    const hunkF2 = hunks.find(h => h.summary.includes('CHANGE-FOR-F2'));
    expect(hunkF1).toBeDefined();
    expect(hunkF2).toBeDefined();

    // Move the F2 hunk to F2 changelist
    hunkMgr.assign(hunkF2!.id, f2.id);
    manager.addFileShared(f2.id, 'a.txt');

    // Verify assignments
    expect(hunkMgr.getHunksForFileInChangelist('a.txt', f1.id)).toHaveLength(1);
    expect(hunkMgr.getHunksForFileInChangelist('a.txt', f2.id)).toHaveLength(1);

    // Commit F1 (only the line-10 change)
    await commitChangelist(f1.id, 'F1: line 10 change');

    const diff1 = gitShowDiff('HEAD');
    expect(diff1).toContain('CHANGE-FOR-F1');
    expect(diff1).not.toContain('CHANGE-FOR-F2');

    // a.txt should still be dirty (F2's change remains)
    const dirty = await git.getDirtyFilePaths();
    expect(dirty.has('a.txt')).toBe(true);

    // Commit F2 (only the line-80 change)
    await commitChangelist(f2.id, 'F2: line 80 change');

    const diff2 = gitShowDiff('HEAD');
    expect(diff2).toContain('CHANGE-FOR-F2');
    expect(diff2).not.toContain('CHANGE-FOR-F1');

    // Now clean
    const dirtyAfter = await git.getDirtyFilePaths();
    expect(dirtyAfter.has('a.txt')).toBe(false);
  });

  // =====================================================
  // TEST 3: 4 hunks in 4 changelists, commit in reverse order
  // =====================================================
  it('should handle 4 hunks across 4 changelists committed in reverse', async () => {
    const f1 = manager.create('F1');
    const f2 = manager.create('F2');
    const f3 = manager.create('F3');
    const f4 = manager.create('F4');
    manager.setActive(f1.id);

    // 4 distant changes in a.txt
    modifyLine('a.txt', 10, 'HUNK-F1');
    modifyLine('a.txt', 35, 'HUNK-F2');
    modifyLine('a.txt', 60, 'HUNK-F3');
    modifyLine('a.txt', 85, 'HUNK-F4');

    manager.addFileShared(f1.id, 'a.txt');
    await hunkMgr.refresh();

    const hunks = hunkMgr.getHunksForFile('a.txt');
    expect(hunks.length).toBe(4);

    // Assign each hunk to its changelist
    for (const hunk of hunks) {
      if (hunk.summary.includes('HUNK-F2')) {
        hunkMgr.assign(hunk.id, f2.id);
        manager.addFileShared(f2.id, 'a.txt');
      } else if (hunk.summary.includes('HUNK-F3')) {
        hunkMgr.assign(hunk.id, f3.id);
        manager.addFileShared(f3.id, 'a.txt');
      } else if (hunk.summary.includes('HUNK-F4')) {
        hunkMgr.assign(hunk.id, f4.id);
        manager.addFileShared(f4.id, 'a.txt');
      }
      // HUNK-F1 stays in F1 (auto-assigned)
    }

    // Commit in reverse order: F4, F3, F2, F1
    await commitChangelist(f4.id, 'commit-F4');
    expect(gitShowDiff('HEAD')).toContain('HUNK-F4');
    expect(gitShowDiff('HEAD')).not.toContain('HUNK-F3');

    await commitChangelist(f3.id, 'commit-F3');
    expect(gitShowDiff('HEAD')).toContain('HUNK-F3');
    expect(gitShowDiff('HEAD')).not.toContain('HUNK-F2');

    await commitChangelist(f2.id, 'commit-F2');
    expect(gitShowDiff('HEAD')).toContain('HUNK-F2');
    expect(gitShowDiff('HEAD')).not.toContain('HUNK-F1');

    await commitChangelist(f1.id, 'commit-F1');
    expect(gitShowDiff('HEAD')).toContain('HUNK-F1');

    // All clean
    const dirty = await git.getDirtyFilePaths();
    expect(dirty.has('a.txt')).toBe(false);

    // Verify git log has 5 commits (initial + 4)
    const log = gitLog();
    expect(log).toHaveLength(5);
    expect(log[1]).toContain('commit-F4');
    expect(log[2]).toContain('commit-F3');
    expect(log[3]).toContain('commit-F2');
    expect(log[4]).toContain('commit-F1');
  });

  // =====================================================
  // TEST 4: Multi-file + hunk-level mixed
  // =====================================================
  it('should handle hunks across multiple files in different changelists', async () => {
    const feature = manager.create('Feature');
    const bugfix = manager.create('Bugfix');
    manager.setActive(feature.id);

    // Feature: change a.txt line 15 and b.txt line 15
    modifyLine('a.txt', 15, 'FEATURE-IN-A');
    modifyLine('b.txt', 15, 'FEATURE-IN-B');

    // Bugfix: change a.txt line 85
    modifyLine('a.txt', 85, 'BUGFIX-IN-A');

    manager.addFileShared(feature.id, 'a.txt');
    manager.addFileShared(feature.id, 'b.txt');
    await hunkMgr.refresh();

    // Move bugfix hunk to Bugfix changelist
    const aHunks = hunkMgr.getHunksForFile('a.txt');
    const bugfixHunk = aHunks.find(h => h.summary.includes('BUGFIX-IN-A'));
    expect(bugfixHunk).toBeDefined();
    hunkMgr.assign(bugfixHunk!.id, bugfix.id);
    manager.addFileShared(bugfix.id, 'a.txt');

    // Commit Bugfix first
    await commitChangelist(bugfix.id, 'fix: bugfix in a.txt');

    const bugfixDiff = gitShowDiff('HEAD');
    expect(bugfixDiff).toContain('BUGFIX-IN-A');
    expect(bugfixDiff).not.toContain('FEATURE-IN-A');
    expect(bugfixDiff).not.toContain('FEATURE-IN-B');
    expect(gitShowFiles('HEAD')).toBe('a.txt'); // Only a.txt

    // Commit Feature
    await commitChangelist(feature.id, 'feat: feature changes');

    const featureDiff = gitShowDiff('HEAD');
    expect(featureDiff).toContain('FEATURE-IN-A');
    expect(featureDiff).toContain('FEATURE-IN-B');
    expect(featureDiff).not.toContain('BUGFIX-IN-A');

    // All clean
    const dirty = await git.getDirtyFilePaths();
    expect(dirty.size).toBe(0);
  });

  // =====================================================
  // TEST 5: Fingerprint matching — assignments survive commits
  // =====================================================
  it('should preserve hunk assignments after committing another hunk', async () => {
    const f1 = manager.create('F1');
    const f2 = manager.create('F2');
    manager.setActive(f1.id);

    modifyLine('a.txt', 10, 'KEEP-IN-F1');
    modifyLine('a.txt', 80, 'COMMIT-FROM-F2');

    manager.addFileShared(f1.id, 'a.txt');
    await hunkMgr.refresh();

    const hunks = hunkMgr.getHunksForFile('a.txt');
    const f2Hunk = hunks.find(h => h.summary.includes('COMMIT-FROM-F2'));
    hunkMgr.assign(f2Hunk!.id, f2.id);
    manager.addFileShared(f2.id, 'a.txt');

    // Commit F2
    await commitChangelist(f2.id, 'F2 commit');

    // After commit, F1's hunk should still be assigned to F1
    await hunkMgr.refresh();
    const remainingHunks = hunkMgr.getHunksForFile('a.txt');
    expect(remainingHunks).toHaveLength(1);

    const f1Assignment = hunkMgr.getAssignment(remainingHunks[0].id);
    expect(f1Assignment).toBe(f1.id);
  });

  // =====================================================
  // TEST 6: Drag hunk between changelists
  // =====================================================
  it('should correctly move a hunk from one changelist to another', async () => {
    const f1 = manager.create('F1');
    const f2 = manager.create('F2');
    manager.setActive(f1.id);

    modifyLine('a.txt', 10, 'HUNK-A');
    modifyLine('a.txt', 50, 'HUNK-B');
    modifyLine('a.txt', 90, 'HUNK-C');

    manager.addFileShared(f1.id, 'a.txt');
    await hunkMgr.refresh();

    // All 3 hunks in F1
    expect(hunkMgr.getHunksForFileInChangelist('a.txt', f1.id)).toHaveLength(3);

    // Move HUNK-B to F2
    const hunks = hunkMgr.getHunksForFile('a.txt');
    const hunkB = hunks.find(h => h.summary.includes('HUNK-B'));
    hunkMgr.assign(hunkB!.id, f2.id);
    manager.addFileShared(f2.id, 'a.txt');

    // F1 has 2 hunks, F2 has 1
    expect(hunkMgr.getHunksForFileInChangelist('a.txt', f1.id)).toHaveLength(2);
    expect(hunkMgr.getHunksForFileInChangelist('a.txt', f2.id)).toHaveLength(1);

    // Commit F2 (only HUNK-B)
    await commitChangelist(f2.id, 'only hunk B');
    expect(gitShowDiff('HEAD')).toContain('HUNK-B');
    expect(gitShowDiff('HEAD')).not.toContain('HUNK-A');
    expect(gitShowDiff('HEAD')).not.toContain('HUNK-C');

    // Commit F1 (HUNK-A and HUNK-C)
    await commitChangelist(f1.id, 'hunks A and C');
    expect(gitShowDiff('HEAD')).toContain('HUNK-A');
    expect(gitShowDiff('HEAD')).toContain('HUNK-C');
    expect(gitShowDiff('HEAD')).not.toContain('HUNK-B');
  });
});
