import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GitService } from './git-service';

describe('GitService', () => {
  let testDir: string;
  let git: GitService;

  function run(args: string[]): string {
    return execFileSync('git', args, { cwd: testDir, encoding: 'utf-8' });
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'changelist-test-'));
    run(['init']);
    run(['config', 'user.email', 'test@test.com']);
    run(['config', 'user.name', 'Test']);

    // Create initial commit
    writeFileSync(join(testDir, 'initial.txt'), 'initial');
    run(['add', '.']);
    run(['commit', '-m', 'initial']);

    git = new GitService(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should detect repo', async () => {
    expect(await git.isGitRepo()).toBe(true);
  });

  it('should detect modified files', async () => {
    writeFileSync(join(testDir, 'initial.txt'), 'modified');
    const files = await git.getChangedFiles();
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('initial.txt');
  });

  it('should detect new untracked files', async () => {
    writeFileSync(join(testDir, 'new-file.txt'), 'new');
    const files = await git.getChangedFiles();
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('new-file.txt');
    expect(files[0].status).toContain('?');
  });

  it('should detect files in subdirectories', async () => {
    mkdirSync(join(testDir, 'src'));
    writeFileSync(join(testDir, 'src', 'app.ts'), 'code');
    const files = await git.getChangedFiles();
    expect(files.some(f => f.relativePath === 'src/app.ts')).toBe(true);
  });

  it('should return dirty file paths as Set', async () => {
    writeFileSync(join(testDir, 'a.txt'), 'a');
    writeFileSync(join(testDir, 'b.txt'), 'b');
    const dirty = await git.getDirtyFilePaths();
    expect(dirty.has('a.txt')).toBe(true);
    expect(dirty.has('b.txt')).toBe(true);
    expect(dirty.size).toBe(2);
  });

  it('should stage and commit files', async () => {
    writeFileSync(join(testDir, 'feature.txt'), 'feature');
    await git.stageFiles(['feature.txt']);
    const output = await git.commit('add feature');
    expect(output).toContain('add feature');
  });

  it('should stage only specific files', async () => {
    writeFileSync(join(testDir, 'a.txt'), 'a');
    writeFileSync(join(testDir, 'b.txt'), 'b');
    await git.stageFiles(['a.txt']);
    await git.commit('only a');

    // b.txt should still be dirty
    const dirty = await git.getDirtyFilePaths();
    expect(dirty.has('b.txt')).toBe(true);
    expect(dirty.has('a.txt')).toBe(false);
  });

  it('should unstage all files', async () => {
    writeFileSync(join(testDir, 'a.txt'), 'a');
    await git.stageFiles(['a.txt']);
    await git.unstageAll();

    // File should still be untracked but not staged
    const dirty = await git.getDirtyFilePaths();
    expect(dirty.has('a.txt')).toBe(true);
  });

  it('should return empty for clean repo', async () => {
    const files = await git.getChangedFiles();
    expect(files).toHaveLength(0);
  });
});
