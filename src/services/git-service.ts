import { execFile } from 'child_process';

export interface GitFileStatus {
  /** Workspace-relative path */
  relativePath: string;
  /** X = index status, Y = worktree status */
  status: string;
}

export class GitService {
  constructor(private readonly workspaceRoot: string) {}

  /** Get all files with uncommitted changes (staged + unstaged + untracked) */
  async getChangedFiles(): Promise<GitFileStatus[]> {
    const output = await this.exec(['status', '--porcelain', '-uall']);
    if (!output.trim()) {
      return [];
    }

    return output
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => ({
        status: line.slice(0, 2),
        relativePath: line.slice(3).trim(),
      }))
      // Handle renames: "R  old -> new"
      .map(entry => {
        const arrowIndex = entry.relativePath.indexOf(' -> ');
        if (arrowIndex !== -1) {
          return { ...entry, relativePath: entry.relativePath.slice(arrowIndex + 4) };
        }
        return entry;
      });
  }

  /** Get set of all dirty (changed) file paths */
  async getDirtyFilePaths(): Promise<Set<string>> {
    const files = await this.getChangedFiles();
    return new Set(files.map(f => f.relativePath));
  }

  /** Stage specific files */
  async stageFiles(relativePaths: string[]): Promise<void> {
    if (relativePaths.length === 0) return;
    await this.exec(['add', '--', ...relativePaths]);
  }

  /** Unstage all files (reset index) */
  async unstageAll(): Promise<void> {
    try {
      await this.exec(['reset', 'HEAD', '--quiet']);
    } catch {
      // Fails on repos with no commits yet — safe to ignore
    }
  }

  /** Commit staged files with message */
  async commit(message: string): Promise<string> {
    const output = await this.exec(['commit', '-m', message]);
    return output;
  }

  /** Check if directory is a git repo */
  async isGitRepo(): Promise<boolean> {
    try {
      await this.exec(['rev-parse', '--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  }

  /** Get diff for a specific file */
  async getDiff(relativePath: string): Promise<string> {
    return this.exec(['diff', '--', relativePath]);
  }

  /** Get full diff of all unstaged changes */
  async getFullDiff(): Promise<string> {
    return this.exec(['diff']);
  }

  /** Apply a patch to the index (staging area) via stdin */
  async applyPatch(patch: string): Promise<void> {
    await this.execWithStdin(['apply', '--cached', '-'], patch);
  }

  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  private execWithStdin(args: string[], input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = execFile('git', args, { cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      });
      proc.stdin?.write(input);
      proc.stdin?.end();
    });
  }
}
