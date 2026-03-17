import * as vscode from 'vscode';
import {
  Changelist,
  ChangelistFile,
  ChangelistState,
  DEFAULT_CHANGELIST_NAME,
  STATE_VERSION,
} from './types';

export class ChangelistManager {
  private state: ChangelistState;
  private storageUri: vscode.Uri | undefined;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly _onDidChangeActiveList = new vscode.EventEmitter<Changelist>();
  readonly onDidChangeActiveList = this._onDidChangeActiveList.event;

  constructor() {
    this.state = this.createDefaultState();
  }

  async initialize(workspaceFolder: vscode.Uri): Promise<void> {
    const vscodeFolderUri = vscode.Uri.joinPath(workspaceFolder, '.vscode');
    this.storageUri = vscode.Uri.joinPath(vscodeFolderUri, 'changelists.json');

    try {
      const data = await vscode.workspace.fs.readFile(this.storageUri);
      const parsed = JSON.parse(Buffer.from(data).toString('utf-8')) as ChangelistState;
      if (parsed.version === STATE_VERSION && Array.isArray(parsed.changelists)) {
        this.state = parsed;
        this.ensureDefaultChangelist();
      }
    } catch {
      // File doesn't exist yet or is invalid — use default state
    }

    this._onDidChange.fire();
  }

  // --- Getters ---

  getAll(): readonly Changelist[] {
    return this.state.changelists;
  }

  getActive(): Changelist {
    const active = this.state.changelists.find(cl => cl.isActive);
    if (!active) {
      return this.getDefault();
    }
    return active;
  }

  getDefault(): Changelist {
    const def = this.state.changelists.find(cl => cl.isDefault);
    if (!def) {
      throw new Error('Default changelist missing — state is corrupt');
    }
    return def;
  }

  getById(id: string): Changelist | undefined {
    return this.state.changelists.find(cl => cl.id === id);
  }

  // --- CRUD ---

  create(name: string): Changelist {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Changelist name cannot be empty');
    }

    if (this.state.changelists.some(cl => cl.name === trimmed)) {
      throw new Error(`Changelist "${trimmed}" already exists`);
    }

    const changelist: Changelist = {
      id: generateId(),
      name: trimmed,
      isActive: false,
      isDefault: false,
      files: [],
    };

    this.state.changelists.push(changelist);
    this.fireAndSave();
    return changelist;
  }

  rename(id: string, newName: string): void {
    const trimmed = newName.trim();
    if (!trimmed) {
      throw new Error('Changelist name cannot be empty');
    }

    const cl = this.requireById(id);

    if (this.state.changelists.some(other => other.id !== id && other.name === trimmed)) {
      throw new Error(`Changelist "${trimmed}" already exists`);
    }

    cl.name = trimmed;
    this.fireAndSave();
  }

  delete(id: string): void {
    const cl = this.requireById(id);

    if (cl.isDefault) {
      throw new Error('Cannot delete the default changelist');
    }

    // Move files to default changelist
    const defaultCl = this.getDefault();
    for (const file of cl.files) {
      if (!defaultCl.files.some(f => f.relativePath === file.relativePath)) {
        defaultCl.files.push(file);
      }
    }

    // If deleted list was active, make default active
    if (cl.isActive) {
      defaultCl.isActive = true;
      this._onDidChangeActiveList.fire(defaultCl);
    }

    this.state.changelists = this.state.changelists.filter(c => c.id !== id);
    this.fireAndSave();
  }

  setActive(id: string): void {
    const target = this.requireById(id);

    if (target.isActive) {
      return;
    }

    for (const cl of this.state.changelists) {
      cl.isActive = cl.id === id;
    }

    this._onDidChangeActiveList.fire(target);
    this.fireAndSave();
  }

  // --- File Operations ---

  addFile(changelistId: string, relativePath: string): void {
    // Remove from any other changelist first
    this.removeFileFromAll(relativePath);

    const cl = this.requireById(changelistId);
    cl.files.push({
      relativePath,
      addedAt: Date.now(),
    });

    this.fireAndSave();
  }

  /** Add file to a changelist WITHOUT removing from others (for hunk-level sharing) */
  addFileShared(changelistId: string, relativePath: string): void {
    const cl = this.requireById(changelistId);
    if (cl.files.some(f => f.relativePath === relativePath)) {
      return; // Already in this changelist
    }
    cl.files.push({
      relativePath,
      addedAt: Date.now(),
    });
    this.fireAndSave();
  }

  removeFile(changelistId: string, relativePath: string): void {
    const cl = this.requireById(changelistId);
    cl.files = cl.files.filter(f => f.relativePath !== relativePath);
    this.fireAndSave();
  }

  moveFile(relativePath: string, fromId: string, toId: string): void {
    this.requireById(fromId);
    this.requireById(toId);

    this.removeFile(fromId, relativePath);
    this.addFile(toId, relativePath);
  }

  findFileChangelist(relativePath: string): Changelist | undefined {
    return this.state.changelists.find(cl =>
      cl.files.some(f => f.relativePath === relativePath)
    );
  }

  getFilesForChangelist(id: string): readonly ChangelistFile[] {
    return this.requireById(id).files;
  }

  // --- Persistence ---

  async save(): Promise<void> {
    if (!this.storageUri) {
      return;
    }

    try {
      const json = JSON.stringify(this.state, null, 2);
      const data = Buffer.from(json, 'utf-8');
      await vscode.workspace.fs.writeFile(this.storageUri, data);
    } catch (error) {
      console.error('Failed to save changelists:', error);
    }
  }

  // --- Cleanup ---

  /** Remove files that no longer have git changes */
  removeCleanFiles(dirtyPaths: Set<string>): void {
    let changed = false;

    for (const cl of this.state.changelists) {
      const before = cl.files.length;
      cl.files = cl.files.filter(f => dirtyPaths.has(f.relativePath));
      if (cl.files.length !== before) {
        changed = true;
      }
    }

    if (changed) {
      this.fireAndSave();
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
    this._onDidChangeActiveList.dispose();
  }

  // --- Private ---

  private requireById(id: string): Changelist {
    const cl = this.getById(id);
    if (!cl) {
      throw new Error(`Changelist with id "${id}" not found`);
    }
    return cl;
  }

  private removeFileFromAll(relativePath: string): void {
    for (const cl of this.state.changelists) {
      cl.files = cl.files.filter(f => f.relativePath !== relativePath);
    }
  }

  private createDefaultState(): ChangelistState {
    return {
      version: STATE_VERSION,
      changelists: [
        {
          id: generateId(),
          name: DEFAULT_CHANGELIST_NAME,
          isActive: true,
          isDefault: true,
          files: [],
        },
      ],
    };
  }

  private ensureDefaultChangelist(): void {
    const hasDefault = this.state.changelists.some(cl => cl.isDefault);
    if (!hasDefault) {
      this.state.changelists.unshift({
        id: generateId(),
        name: DEFAULT_CHANGELIST_NAME,
        isActive: true,
        isDefault: true,
        files: [],
      });
    }

    const hasActive = this.state.changelists.some(cl => cl.isActive);
    if (!hasActive) {
      this.getDefault().isActive = true;
    }
  }

  private fireAndSave(): void {
    this._onDidChange.fire();
    void this.save();
  }
}

function generateId(): string {
  return `cl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
