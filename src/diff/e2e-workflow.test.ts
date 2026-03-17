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

  /** Insert a line after a given line number */
  function insertAfter(name: string, lineNum: number, newContent: string): void {
    const content = readFileSync(join(testDir, name), 'utf-8');
    const lines = content.split('\n');
    lines.splice(lineNum, 0, newContent);
    writeFileSync(join(testDir, name), lines.join('\n'));
  }

  /** Delete a specific line */
  function deleteLine(name: string, lineNum: number): void {
    const content = readFileSync(join(testDir, name), 'utf-8');
    const lines = content.split('\n');
    lines.splice(lineNum - 1, 1);
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

  /** Verify only the expected strings appear in a commit diff */
  function assertCommitContains(ref: string, expected: string[], notExpected: string[]): void {
    const diff = gitShowDiff(ref);
    for (const s of expected) {
      expect(diff, `Expected "${s}" in ${ref}`).toContain(s);
    }
    for (const s of notExpected) {
      expect(diff, `Unexpected "${s}" in ${ref}`).not.toContain(s);
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
    writeTestFile('c.txt', 100);
    writeTestFile('d.txt', 100);
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

  // =====================================================
  // TEST 7: Wild 4-file cross-changelist chaos
  // =====================================================
  it('should handle 4 files with hunks scattered across 4 changelists', async () => {
    const auth = manager.create('Auth');
    const bugfix = manager.create('Bugfix');
    const refactor = manager.create('Refactor');
    const docs = manager.create('Docs');
    manager.setActive(auth.id);

    // Auth: changes in a.txt(L10), b.txt(L20), c.txt(L15)
    modifyLine('a.txt', 10, 'AUTH-IN-A');
    modifyLine('b.txt', 20, 'AUTH-IN-B');
    modifyLine('c.txt', 15, 'AUTH-IN-C');

    // Bugfix: changes in a.txt(L50), d.txt(L30)
    modifyLine('a.txt', 50, 'BUGFIX-IN-A');
    modifyLine('d.txt', 30, 'BUGFIX-IN-D');

    // Refactor: changes in b.txt(L60), c.txt(L70), d.txt(L80)
    modifyLine('b.txt', 60, 'REFACTOR-IN-B');
    modifyLine('c.txt', 70, 'REFACTOR-IN-C');
    modifyLine('d.txt', 80, 'REFACTOR-IN-D');

    // Docs: changes in d.txt(L10)
    modifyLine('d.txt', 10, 'DOCS-IN-D');

    // All files start in Auth (active)
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
      manager.addFileShared(auth.id, f);
    }
    await hunkMgr.refresh();

    // Now reassign hunks to correct changelists
    const reassign = (file: string, searchStr: string, clId: string) => {
      const hunks = hunkMgr.getHunksForFile(file);
      const hunk = hunks.find(h => h.summary.includes(searchStr));
      expect(hunk, `Hunk "${searchStr}" not found in ${file}`).toBeDefined();
      hunkMgr.assign(hunk!.id, clId);
      manager.addFileShared(clId, file);
    };

    // Move bugfix hunks
    reassign('a.txt', 'BUGFIX-IN-A', bugfix.id);
    reassign('d.txt', 'BUGFIX-IN-D', bugfix.id);

    // Move refactor hunks
    reassign('b.txt', 'REFACTOR-IN-B', refactor.id);
    reassign('c.txt', 'REFACTOR-IN-C', refactor.id);
    reassign('d.txt', 'REFACTOR-IN-D', refactor.id);

    // Move docs hunk
    reassign('d.txt', 'DOCS-IN-D', docs.id);

    // Auth keeps: AUTH-IN-A, AUTH-IN-B, AUTH-IN-C

    // Verify assignment counts
    expect(hunkMgr.getHunksForChangelist(auth.id).size).toBeGreaterThan(0);
    expect(hunkMgr.getHunksForChangelist(bugfix.id).size).toBeGreaterThan(0);
    expect(hunkMgr.getHunksForChangelist(refactor.id).size).toBeGreaterThan(0);
    expect(hunkMgr.getHunksForChangelist(docs.id).size).toBeGreaterThan(0);

    // Commit in random order: Bugfix → Docs → Auth → Refactor

    // --- Bugfix: a.txt(L50) + d.txt(L30) ---
    await commitChangelist(bugfix.id, 'fix: bugfix');
    assertCommitContains('HEAD',
      ['BUGFIX-IN-A', 'BUGFIX-IN-D'],
      ['AUTH-IN-A', 'REFACTOR-IN-B', 'DOCS-IN-D'],
    );

    // --- Docs: d.txt(L10) ---
    await commitChangelist(docs.id, 'docs: update');
    assertCommitContains('HEAD',
      ['DOCS-IN-D'],
      ['BUGFIX-IN-D', 'REFACTOR-IN-D', 'AUTH-IN-A'],
    );

    // --- Auth: a.txt(L10) + b.txt(L20) + c.txt(L15) ---
    await commitChangelist(auth.id, 'feat: auth');
    assertCommitContains('HEAD',
      ['AUTH-IN-A', 'AUTH-IN-B', 'AUTH-IN-C'],
      ['BUGFIX-IN-A', 'REFACTOR-IN-B', 'REFACTOR-IN-C'],
    );

    // --- Refactor: b.txt(L60) + c.txt(L70) + d.txt(L80) ---
    await commitChangelist(refactor.id, 'refactor: cleanup');
    assertCommitContains('HEAD',
      ['REFACTOR-IN-B', 'REFACTOR-IN-C', 'REFACTOR-IN-D'],
      ['AUTH-IN-B', 'AUTH-IN-C', 'DOCS-IN-D'],
    );

    // Everything clean
    const dirty = await git.getDirtyFilePaths();
    expect(dirty.size).toBe(0);

    // 5 commits total
    const log = gitLog();
    expect(log).toHaveLength(5);
  });

  // =====================================================
  // TEST 8: Multiple hunks per file across all 4 files
  // =====================================================
  it('should handle multiple hunks per file across 4 files in 3 changelists', async () => {
    const f1 = manager.create('F1');
    const f2 = manager.create('F2');
    const f3 = manager.create('F3');
    manager.setActive(f1.id);

    // Each file gets 3 changes, each going to a different changelist
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
    for (const file of files) {
      modifyLine(file, 10, `F1-IN-${file.toUpperCase()}`);
      modifyLine(file, 50, `F2-IN-${file.toUpperCase()}`);
      modifyLine(file, 90, `F3-IN-${file.toUpperCase()}`);
      manager.addFileShared(f1.id, file);
    }
    await hunkMgr.refresh();

    // Reassign F2 and F3 hunks in all files
    for (const file of files) {
      const hunks = hunkMgr.getHunksForFile(file);
      expect(hunks.length, `Expected 3 hunks in ${file}`).toBe(3);
      for (const hunk of hunks) {
        if (hunk.summary.includes('F2-IN')) {
          hunkMgr.assign(hunk.id, f2.id);
          manager.addFileShared(f2.id, file);
        } else if (hunk.summary.includes('F3-IN')) {
          hunkMgr.assign(hunk.id, f3.id);
          manager.addFileShared(f3.id, file);
        }
      }
    }

    // Commit F2 first (should get exactly the F2 hunks from all 4 files)
    await commitChangelist(f2.id, 'commit-F2');
    const f2Diff = gitShowDiff('HEAD');
    for (const file of files) {
      expect(f2Diff).toContain(`F2-IN-${file.toUpperCase()}`);
      expect(f2Diff).not.toContain(`F1-IN-${file.toUpperCase()}`);
      expect(f2Diff).not.toContain(`F3-IN-${file.toUpperCase()}`);
    }

    // Commit F3 (should get exactly the F3 hunks from all 4 files)
    await commitChangelist(f3.id, 'commit-F3');
    const f3Diff = gitShowDiff('HEAD');
    for (const file of files) {
      expect(f3Diff).toContain(`F3-IN-${file.toUpperCase()}`);
      expect(f3Diff).not.toContain(`F1-IN-${file.toUpperCase()}`);
      expect(f3Diff).not.toContain(`F2-IN-${file.toUpperCase()}`);
    }

    // Commit F1 (should get the remaining F1 hunks from all 4 files)
    await commitChangelist(f1.id, 'commit-F1');
    const f1Diff = gitShowDiff('HEAD');
    for (const file of files) {
      expect(f1Diff).toContain(`F1-IN-${file.toUpperCase()}`);
      expect(f1Diff).not.toContain(`F2-IN-${file.toUpperCase()}`);
      expect(f1Diff).not.toContain(`F3-IN-${file.toUpperCase()}`);
    }

    // Everything clean
    const dirty = await git.getDirtyFilePaths();
    expect(dirty.size).toBe(0);
  });

  // =====================================================
  // TEST 9: Mixed operations — insert, modify, delete across files
  // =====================================================
  it('should handle inserts, modifications and deletions across files', async () => {
    const feat = manager.create('Feature');
    const fix = manager.create('Fix');
    manager.setActive(feat.id);

    // Feature: insert new lines in a.txt and c.txt
    insertAfter('a.txt', 15, 'FEAT-INSERT-A');
    insertAfter('c.txt', 25, 'FEAT-INSERT-C');

    // Fix: modify existing lines in b.txt, delete line in d.txt
    modifyLine('b.txt', 40, 'FIX-MODIFY-B');
    deleteLine('d.txt', 50);

    for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
      manager.addFileShared(feat.id, f);
    }
    await hunkMgr.refresh();

    // Move fix hunks
    for (const file of ['b.txt', 'd.txt']) {
      const hunks = hunkMgr.getHunksForFile(file);
      for (const hunk of hunks) {
        if (hunk.summary.includes('FIX-MODIFY-B') || file === 'd.txt') {
          hunkMgr.assign(hunk.id, fix.id);
          manager.addFileShared(fix.id, file);
        }
      }
    }

    // Commit Fix
    await commitChangelist(fix.id, 'fix: corrections');
    const fixDiff = gitShowDiff('HEAD');
    expect(fixDiff).toContain('FIX-MODIFY-B');
    expect(fixDiff).not.toContain('FEAT-INSERT-A');
    expect(fixDiff).not.toContain('FEAT-INSERT-C');
    // d.txt deletion should be in this commit
    expect(gitShowFiles('HEAD')).toContain('d.txt');

    // Commit Feature
    await commitChangelist(feat.id, 'feat: additions');
    const featDiff = gitShowDiff('HEAD');
    expect(featDiff).toContain('FEAT-INSERT-A');
    expect(featDiff).toContain('FEAT-INSERT-C');
    expect(featDiff).not.toContain('FIX-MODIFY-B');

    const dirty = await git.getDirtyFilePaths();
    expect(dirty.size).toBe(0);
  });

  // =====================================================
  // TEST 10: Reassign all hunks mid-flight and commit
  // =====================================================
  it('should handle reassigning hunks after initial assignment', async () => {
    const alpha = manager.create('Alpha');
    const beta = manager.create('Beta');
    manager.setActive(alpha.id);

    // 4 changes across 2 files
    modifyLine('a.txt', 10, 'ALPHA-A1');
    modifyLine('a.txt', 60, 'ALPHA-A2');
    modifyLine('b.txt', 20, 'ALPHA-B1');
    modifyLine('b.txt', 70, 'ALPHA-B2');

    for (const f of ['a.txt', 'b.txt']) {
      manager.addFileShared(alpha.id, f);
    }
    await hunkMgr.refresh();

    // All 4 hunks start in Alpha
    expect(hunkMgr.getHunksForChangelist(alpha.id).size).toBe(2);

    // Now move ALPHA-A2 and ALPHA-B1 to Beta (cross-file, cross-position)
    const aHunks = hunkMgr.getHunksForFile('a.txt');
    const bHunks = hunkMgr.getHunksForFile('b.txt');

    const a2 = aHunks.find(h => h.summary.includes('ALPHA-A2'));
    const b1 = bHunks.find(h => h.summary.includes('ALPHA-B1'));
    expect(a2).toBeDefined();
    expect(b1).toBeDefined();

    hunkMgr.assign(a2!.id, beta.id);
    manager.addFileShared(beta.id, 'a.txt');
    hunkMgr.assign(b1!.id, beta.id);
    manager.addFileShared(beta.id, 'b.txt');

    // Now reassign ALPHA-A2 BACK to Alpha (changed mind!)
    hunkMgr.assign(a2!.id, alpha.id);

    // Beta should only have ALPHA-B1 now
    await hunkMgr.refresh();

    // Commit Beta
    await commitChangelist(beta.id, 'beta commit');
    assertCommitContains('HEAD',
      ['ALPHA-B1'],
      ['ALPHA-A1', 'ALPHA-A2', 'ALPHA-B2'],
    );

    // Commit Alpha (has A1, A2, B2)
    await commitChangelist(alpha.id, 'alpha commit');
    assertCommitContains('HEAD',
      ['ALPHA-A1', 'ALPHA-A2', 'ALPHA-B2'],
      ['ALPHA-B1'],
    );

    const dirty = await git.getDirtyFilePaths();
    expect(dirty.size).toBe(0);
  });

  // =====================================================
  // TEST 11: Commit order stress — forward, reverse, random
  // =====================================================
  it('should commit 5 changelists in random order across 4 files', async () => {
    const lists = [
      manager.create('CL-1'),
      manager.create('CL-2'),
      manager.create('CL-3'),
      manager.create('CL-4'),
      manager.create('CL-5'),
    ];
    manager.setActive(lists[0].id);

    // CL-1: a.txt L10, b.txt L10
    modifyLine('a.txt', 10, 'CL1-A'); modifyLine('b.txt', 10, 'CL1-B');
    // CL-2: a.txt L30, c.txt L30
    modifyLine('a.txt', 30, 'CL2-A'); modifyLine('c.txt', 30, 'CL2-C');
    // CL-3: b.txt L50, d.txt L50
    modifyLine('b.txt', 50, 'CL3-B'); modifyLine('d.txt', 50, 'CL3-D');
    // CL-4: c.txt L70, d.txt L70
    modifyLine('c.txt', 70, 'CL4-C'); modifyLine('d.txt', 70, 'CL4-D');
    // CL-5: a.txt L90, b.txt L90, c.txt L10, d.txt L10
    modifyLine('a.txt', 90, 'CL5-A'); modifyLine('b.txt', 90, 'CL5-B');
    modifyLine('c.txt', 10, 'CL5-C'); modifyLine('d.txt', 10, 'CL5-D');

    // Add all files to CL-1 initially
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
      manager.addFileShared(lists[0].id, f);
    }
    await hunkMgr.refresh();

    // Helper to reassign by content
    const moveHunk = (file: string, search: string, clId: string) => {
      const hunks = hunkMgr.getHunksForFile(file);
      const h = hunks.find(hk => hk.summary.includes(search));
      if (h) {
        hunkMgr.assign(h.id, clId);
        manager.addFileShared(clId, file);
      }
    };

    // Reassign to correct changelists
    moveHunk('a.txt', 'CL2-A', lists[1].id);
    moveHunk('c.txt', 'CL2-C', lists[1].id);
    moveHunk('b.txt', 'CL3-B', lists[2].id);
    moveHunk('d.txt', 'CL3-D', lists[2].id);
    moveHunk('c.txt', 'CL4-C', lists[3].id);
    moveHunk('d.txt', 'CL4-D', lists[3].id);
    moveHunk('a.txt', 'CL5-A', lists[4].id);
    moveHunk('b.txt', 'CL5-B', lists[4].id);
    moveHunk('c.txt', 'CL5-C', lists[4].id);
    moveHunk('d.txt', 'CL5-D', lists[4].id);

    // Commit in random order: 3, 5, 1, 4, 2
    await commitChangelist(lists[2].id, 'CL-3');
    assertCommitContains('HEAD', ['CL3-B', 'CL3-D'], ['CL1-', 'CL2-', 'CL4-', 'CL5-']);

    await commitChangelist(lists[4].id, 'CL-5');
    assertCommitContains('HEAD', ['CL5-A', 'CL5-B', 'CL5-C', 'CL5-D'], ['CL1-', 'CL2-', 'CL4-']);

    await commitChangelist(lists[0].id, 'CL-1');
    assertCommitContains('HEAD', ['CL1-A', 'CL1-B'], ['CL2-', 'CL4-']);

    await commitChangelist(lists[3].id, 'CL-4');
    assertCommitContains('HEAD', ['CL4-C', 'CL4-D'], ['CL2-']);

    await commitChangelist(lists[1].id, 'CL-2');
    assertCommitContains('HEAD', ['CL2-A', 'CL2-C'], []);

    // All clean
    const dirty = await git.getDirtyFilePaths();
    expect(dirty.size).toBe(0);

    // 6 commits total (initial + 5)
    expect(gitLog()).toHaveLength(6);
  });

  // =====================================================
  // TEST 12: Same file in all changelists (max fragmentation)
  // =====================================================
  it('should handle one file with hunks in 5 different changelists', async () => {
    const cls = Array.from({ length: 5 }, (_, i) => manager.create(`CL-${i + 1}`));
    manager.setActive(cls[0].id);

    // 5 well-separated changes in a.txt
    modifyLine('a.txt', 10, 'CHANGE-CL1');
    modifyLine('a.txt', 25, 'CHANGE-CL2');
    modifyLine('a.txt', 45, 'CHANGE-CL3');
    modifyLine('a.txt', 65, 'CHANGE-CL4');
    modifyLine('a.txt', 85, 'CHANGE-CL5');

    manager.addFileShared(cls[0].id, 'a.txt');
    await hunkMgr.refresh();

    const hunks = hunkMgr.getHunksForFile('a.txt');
    expect(hunks.length).toBe(5);

    // Assign each hunk to its changelist
    for (let i = 1; i < 5; i++) {
      const hunk = hunks.find(h => h.summary.includes(`CHANGE-CL${i + 1}`));
      expect(hunk, `Hunk for CL-${i + 1}`).toBeDefined();
      hunkMgr.assign(hunk!.id, cls[i].id);
      manager.addFileShared(cls[i].id, 'a.txt');
    }

    // Commit in order 1..5
    for (let i = 0; i < 5; i++) {
      await commitChangelist(cls[i].id, `commit-CL${i + 1}`);
      assertCommitContains('HEAD', [`CHANGE-CL${i + 1}`], []);

      // Verify other changes are NOT in this commit
      for (let j = i + 1; j < 5; j++) {
        const diff = gitShowDiff('HEAD');
        expect(diff).not.toContain(`CHANGE-CL${j + 1}`);
      }
    }

    const dirty = await git.getDirtyFilePaths();
    expect(dirty.size).toBe(0);
    expect(gitLog()).toHaveLength(6);
  });
});
