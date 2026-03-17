import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseDiff, buildPatch } from './diff-parser';

describe('DiffParser', () => {
  describe('parseDiff', () => {
    it('should parse a simple single-hunk diff', () => {
      const diff = [
        'diff --git a/file.txt b/file.txt',
        'index abc1234..def5678 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,3 +1,4 @@',
        ' line1',
        '+added line',
        ' line2',
        ' line3',
      ].join('\n');

      const files = parseDiff(diff);
      expect(files).toHaveLength(1);
      expect(files[0].filePath).toBe('file.txt');
      expect(files[0].hunks).toHaveLength(1);

      const hunk = files[0].hunks[0];
      expect(hunk.oldStart).toBe(1);
      expect(hunk.oldLines).toBe(3);
      expect(hunk.newStart).toBe(1);
      expect(hunk.newLines).toBe(4);
      expect(hunk.summary).toBe('added line');
    });
    //changed
    it('should parse multiple hunks in one file', () => {
      const diff = [
        'diff --git a/file.txt b/file.txt',
        'index abc1234..def5678 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,3 +1,4 @@',
        ' line1',
        '+added at top',
        ' line2',
        ' line3',
        '@@ -50,3 +51,4 @@',
        ' line50',
        '+added at bottom',
        ' line51',
        ' line52',
      ].join('\n');

      const files = parseDiff(diff);
      expect(files).toHaveLength(1);
      expect(files[0].hunks).toHaveLength(2);
      expect(files[0].hunks[0].oldStart).toBe(1);
      expect(files[0].hunks[0].summary).toBe('added at top');
      expect(files[0].hunks[1].oldStart).toBe(50);
      expect(files[0].hunks[1].summary).toBe('added at bottom');
    });

    it('should parse multiple files', () => {
      const diff = [
        'diff --git a/a.txt b/a.txt',
        'index abc..def 100644',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,2 +1,3 @@',
        ' line1',
        '+new in a',
        ' line2',
        'diff --git a/b.txt b/b.txt',
        'index ghi..jkl 100644',
        '--- a/b.txt',
        '+++ b/b.txt',
        '@@ -1,2 +1,3 @@',
        ' line1',
        '+new in b',
        ' line2',
      ].join('\n');

      const files = parseDiff(diff);
      expect(files).toHaveLength(2);
      expect(files[0].filePath).toBe('a.txt');
      expect(files[1].filePath).toBe('b.txt');
    });

    it('should parse deletions', () => {
      const diff = [
        'diff --git a/file.txt b/file.txt',
        'index abc..def 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,4 +1,3 @@',
        ' line1',
        '-removed line',
        ' line2',
        ' line3',
      ].join('\n');

      const files = parseDiff(diff);
      const hunk = files[0].hunks[0];
      expect(hunk.oldLines).toBe(4);
      expect(hunk.newLines).toBe(3);
      expect(hunk.summary).toBe('removed line');
    });

    it('should handle subdirectory paths', () => {
      const diff = [
        'diff --git a/src/components/app.tsx b/src/components/app.tsx',
        'index abc..def 100644',
        '--- a/src/components/app.tsx',
        '+++ b/src/components/app.tsx',
        '@@ -10,3 +10,4 @@',
        ' code',
        '+new code',
        ' more code',
      ].join('\n');

      const files = parseDiff(diff);
      expect(files[0].filePath).toBe('src/components/app.tsx');
    });

    it('should handle empty diff', () => {
      expect(parseDiff('')).toEqual([]);
    });

    it('should handle new file mode', () => {
      const diff = [
        'diff --git a/new.txt b/new.txt',
        'new file mode 100644',
        'index 0000000..abc1234',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1,3 @@',
        '+line1',
        '+line2',
        '+line3',
      ].join('\n');

      const files = parseDiff(diff);
      expect(files).toHaveLength(1);
      expect(files[0].hunks).toHaveLength(1);
      expect(files[0].hunks[0].newLines).toBe(3);
    });

    it('should handle hunk header without line count (single line)', () => {
      const diff = [
        'diff --git a/file.txt b/file.txt',
        'index abc..def 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1 +1,2 @@',
        ' line1',
        '+added',
      ].join('\n');

      const files = parseDiff(diff);
      expect(files[0].hunks[0].oldStart).toBe(1);
      expect(files[0].hunks[0].oldLines).toBe(1);
    });
  });

  describe('buildPatch', () => {
    it('should build a valid patch from a single hunk', () => {
      const diff = [
        'diff --git a/file.txt b/file.txt',
        'index abc..def 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,3 +1,4 @@',
        ' line1',
        '+added',
        ' line2',
        ' line3',
      ].join('\n');

      const files = parseDiff(diff);
      const patch = buildPatch(files[0], files[0].hunks);

      expect(patch).toContain('diff --git');
      expect(patch).toContain('--- a/file.txt');
      expect(patch).toContain('+++ b/file.txt');
      expect(patch).toContain('@@ -1,3 +1,4 @@');
      expect(patch).toContain('+added');
      expect(patch.endsWith('\n')).toBe(true);
    });

    it('should build a patch with only selected hunks', () => {
      const diff = [
        'diff --git a/file.txt b/file.txt',
        'index abc..def 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,3 +1,4 @@',
        ' line1',
        '+hunk1 added',
        ' line2',
        ' line3',
        '@@ -50,3 +51,4 @@',
        ' line50',
        '+hunk2 added',
        ' line51',
        ' line52',
      ].join('\n');

      const files = parseDiff(diff);

      // Only include the second hunk
      const patch = buildPatch(files[0], [files[0].hunks[1]]);

      expect(patch).toContain('@@ -50,3 +51,4 @@');
      expect(patch).toContain('+hunk2 added');
      expect(patch).not.toContain('+hunk1 added');
    });

    it('should return empty string for no hunks', () => {
      const diff = [
        'diff --git a/file.txt b/file.txt',
        'index abc..def 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,3 +1,4 @@',
        ' line1',
        '+added',
        ' line2',
        ' line3',
      ].join('\n');

      const files = parseDiff(diff);
      expect(buildPatch(files[0], [])).toBe('');
    });
  });

  describe('E2E: parse real git diff and apply patch', () => {
    let testDir: string;

    function run(args: string[]): string {
      return execFileSync('git', args, { cwd: testDir, encoding: 'utf-8' });
    }

    beforeEach(() => {
      testDir = mkdtempSync(join(tmpdir(), 'diff-parser-test-'));
      run(['init']);
      run(['config', 'user.email', 'test@test.com']);
      run(['config', 'user.name', 'Test']);
    });

    afterEach(() => {
      rmSync(testDir, { recursive: true, force: true });
    });

    it('should parse real git diff with multiple hunks', () => {
      // Create a file with many lines
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
      writeFileSync(join(testDir, 'big.txt'), lines.join('\n') + '\n');
      run(['add', '.']);
      run(['commit', '-m', 'initial']);

      // Make changes at line 5 and line 95
      lines[4] = 'MODIFIED line 5';
      lines[94] = 'MODIFIED line 95';
      writeFileSync(join(testDir, 'big.txt'), lines.join('\n') + '\n');

      const diffOutput = run(['diff']);
      const files = parseDiff(diffOutput);

      expect(files).toHaveLength(1);
      expect(files[0].filePath).toBe('big.txt');
      expect(files[0].hunks.length).toBeGreaterThanOrEqual(2);

      const hunkNear5 = files[0].hunks.find(h => h.summary.includes('MODIFIED line 5'));
      const hunkNear95 = files[0].hunks.find(h => h.summary.includes('MODIFIED line 95'));
      expect(hunkNear5).toBeDefined();
      expect(hunkNear95).toBeDefined();
    });

    it('should apply a partial patch via git apply --cached', () => {
      // Create file with many lines
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
      writeFileSync(join(testDir, 'big.txt'), lines.join('\n') + '\n');
      run(['add', '.']);
      run(['commit', '-m', 'initial']);

      // Modify at two distant locations
      lines[4] = 'CHANGE_A at line 5';
      lines[94] = 'CHANGE_B at line 95';
      writeFileSync(join(testDir, 'big.txt'), lines.join('\n') + '\n');

      const diffOutput = run(['diff']);
      const files = parseDiff(diffOutput);

      // Build patch with only the first hunk (line 5 change)
      const hunkA = files[0].hunks.find(h => h.summary.includes('CHANGE_A'));
      expect(hunkA).toBeDefined();

      const patch = buildPatch(files[0], [hunkA!]);

      // Apply only hunk A to the index
      execFileSync('git', ['apply', '--cached', '-'], {
        cwd: testDir,
        input: patch,
        encoding: 'utf-8',
      });

      // Check what's staged
      const stagedDiff = run(['diff', '--cached']);
      expect(stagedDiff).toContain('CHANGE_A');
      expect(stagedDiff).not.toContain('CHANGE_B');

      // Commit only hunk A
      run(['commit', '-m', 'only change A']);

      // Verify CHANGE_B is still in working tree
      const remainingDiff = run(['diff']);
      expect(remainingDiff).toContain('CHANGE_B');
      expect(remainingDiff).not.toContain('CHANGE_A');
    });

    it('should handle multi-file partial patches', () => {
      // Create two files
      const linesA = Array.from({ length: 50 }, (_, i) => `a-line ${i + 1}`);
      const linesB = Array.from({ length: 50 }, (_, i) => `b-line ${i + 1}`);
      writeFileSync(join(testDir, 'a.txt'), linesA.join('\n') + '\n');
      writeFileSync(join(testDir, 'b.txt'), linesB.join('\n') + '\n');
      run(['add', '.']);
      run(['commit', '-m', 'initial']);

      // Modify both files
      linesA[4] = 'MODIFIED a-line 5';
      linesB[4] = 'MODIFIED b-line 5';
      writeFileSync(join(testDir, 'a.txt'), linesA.join('\n') + '\n');
      writeFileSync(join(testDir, 'b.txt'), linesB.join('\n') + '\n');

      const diffOutput = run(['diff']);
      const files = parseDiff(diffOutput);

      expect(files).toHaveLength(2);

      // Apply only a.txt patch
      const patchA = buildPatch(files[0], files[0].hunks);
      execFileSync('git', ['apply', '--cached', '-'], {
        cwd: testDir,
        input: patchA,
        encoding: 'utf-8',
      });

      run(['commit', '-m', 'only a.txt']);

      // b.txt should still be dirty
      const remaining = run(['diff', '--name-only']).trim();
      expect(remaining).toBe('b.txt');
    });
  });
});
