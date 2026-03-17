import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChangelistManager } from './changelist-manager';
import { DEFAULT_CHANGELIST_NAME } from './types';

describe('ChangelistManager', () => {
  let manager: ChangelistManager;

  beforeEach(() => {
    manager = new ChangelistManager();
  });

  describe('initialization', () => {
    it('should start with a default changelist', () => {
      const all = manager.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe(DEFAULT_CHANGELIST_NAME);
      expect(all[0].isDefault).toBe(true);
      expect(all[0].isActive).toBe(true);
    });

    it('should have an active changelist', () => {
      const active = manager.getActive();
      expect(active).toBeDefined();
      expect(active.name).toBe(DEFAULT_CHANGELIST_NAME);
    });
  });

  describe('create', () => {
    it('should create a new changelist', () => {
      const cl = manager.create('Feature1');
      expect(cl.name).toBe('Feature1');
      expect(cl.isActive).toBe(false);
      expect(cl.isDefault).toBe(false);
      expect(cl.files).toEqual([]);
      expect(manager.getAll()).toHaveLength(2);
    });

    it('should trim whitespace from name', () => {
      const cl = manager.create('  Feature1  ');
      expect(cl.name).toBe('Feature1');
    });

    it('should throw on empty name', () => {
      expect(() => manager.create('')).toThrow('empty');
      expect(() => manager.create('   ')).toThrow('empty');
    });

    it('should throw on duplicate name', () => {
      manager.create('Feature1');
      expect(() => manager.create('Feature1')).toThrow('already exists');
    });
  });

  describe('rename', () => {
    it('should rename a changelist', () => {
      const cl = manager.create('Feature1');
      manager.rename(cl.id, 'Feature2');
      expect(manager.getById(cl.id)?.name).toBe('Feature2');
    });

    it('should throw on empty name', () => {
      const cl = manager.create('Feature1');
      expect(() => manager.rename(cl.id, '')).toThrow('empty');
    });

    it('should throw on duplicate name', () => {
      const cl = manager.create('Feature1');
      manager.create('Feature2');
      expect(() => manager.rename(cl.id, 'Feature2')).toThrow('already exists');
    });

    it('should throw on non-existent id', () => {
      expect(() => manager.rename('nonexistent', 'NewName')).toThrow('not found');
    });
  });

  describe('delete', () => {
    it('should delete a changelist', () => {
      const cl = manager.create('Feature1');
      manager.delete(cl.id);
      expect(manager.getAll()).toHaveLength(1);
      expect(manager.getById(cl.id)).toBeUndefined();
    });

    it('should not allow deleting the default changelist', () => {
      const defaultCl = manager.getDefault();
      expect(() => manager.delete(defaultCl.id)).toThrow('default');
    });

    it('should move files to default changelist on delete', () => {
      const cl = manager.create('Feature1');
      manager.addFile(cl.id, 'src/a.ts');
      manager.addFile(cl.id, 'src/b.ts');
      manager.delete(cl.id);

      const defaultCl = manager.getDefault();
      expect(defaultCl.files).toHaveLength(2);
      expect(defaultCl.files.map(f => f.relativePath)).toContain('src/a.ts');
      expect(defaultCl.files.map(f => f.relativePath)).toContain('src/b.ts');
    });

    it('should activate default if deleted list was active', () => {
      const cl = manager.create('Feature1');
      manager.setActive(cl.id);
      manager.delete(cl.id);

      const active = manager.getActive();
      expect(active.isDefault).toBe(true);
    });

    it('should not duplicate files when moving to default', () => {
      const defaultCl = manager.getDefault();
      const cl = manager.create('Feature1');

      manager.addFile(defaultCl.id, 'src/a.ts');
      manager.addFile(cl.id, 'src/a.ts');
      manager.delete(cl.id);

      expect(defaultCl.files.filter(f => f.relativePath === 'src/a.ts')).toHaveLength(1);
    });
  });

  describe('setActive', () => {
    it('should set a changelist as active', () => {
      const cl = manager.create('Feature1');
      manager.setActive(cl.id);

      expect(manager.getActive().id).toBe(cl.id);
      expect(manager.getDefault().isActive).toBe(false);
    });

    it('should only have one active changelist at a time', () => {
      const cl1 = manager.create('Feature1');
      const cl2 = manager.create('Feature2');

      manager.setActive(cl1.id);
      manager.setActive(cl2.id);

      const activeCount = manager.getAll().filter(cl => cl.isActive).length;
      expect(activeCount).toBe(1);
      expect(manager.getActive().id).toBe(cl2.id);
    });

    it('should be a no-op if already active', () => {
      const listener = vi.fn();
      manager.onDidChangeActiveList(listener);

      const defaultCl = manager.getDefault();
      manager.setActive(defaultCl.id);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('file operations', () => {
    it('should add a file to a changelist', () => {
      const defaultCl = manager.getDefault();
      manager.addFile(defaultCl.id, 'src/app.ts');

      const files = manager.getFilesForChangelist(defaultCl.id);
      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe('src/app.ts');
      expect(files[0].addedAt).toBeGreaterThan(0);
    });

    it('should remove file from other changelists when adding', () => {
      const defaultCl = manager.getDefault();
      const cl = manager.create('Feature1');

      manager.addFile(defaultCl.id, 'src/app.ts');
      manager.addFile(cl.id, 'src/app.ts');

      expect(manager.getFilesForChangelist(defaultCl.id)).toHaveLength(0);
      expect(manager.getFilesForChangelist(cl.id)).toHaveLength(1);
    });

    it('should remove a file from a changelist', () => {
      const defaultCl = manager.getDefault();
      manager.addFile(defaultCl.id, 'src/app.ts');
      manager.removeFile(defaultCl.id, 'src/app.ts');

      expect(manager.getFilesForChangelist(defaultCl.id)).toHaveLength(0);
    });

    it('should move a file between changelists', () => {
      const defaultCl = manager.getDefault();
      const cl = manager.create('Feature1');

      manager.addFile(defaultCl.id, 'src/app.ts');
      manager.moveFile('src/app.ts', defaultCl.id, cl.id);

      expect(manager.getFilesForChangelist(defaultCl.id)).toHaveLength(0);
      expect(manager.getFilesForChangelist(cl.id)).toHaveLength(1);
    });

    it('should find which changelist a file belongs to', () => {
      const cl = manager.create('Feature1');
      manager.addFile(cl.id, 'src/app.ts');

      const found = manager.findFileChangelist('src/app.ts');
      expect(found?.id).toBe(cl.id);
    });

    it('should return undefined for untracked file', () => {
      expect(manager.findFileChangelist('nonexistent.ts')).toBeUndefined();
    });
  });

  describe('removeCleanFiles', () => {
    it('should remove files that are no longer dirty', () => {
      const defaultCl = manager.getDefault();
      manager.addFile(defaultCl.id, 'src/a.ts');
      manager.addFile(defaultCl.id, 'src/b.ts');
      manager.addFile(defaultCl.id, 'src/c.ts');

      const dirty = new Set(['src/a.ts']); // only a.ts is still dirty
      manager.removeCleanFiles(dirty);

      const files = manager.getFilesForChangelist(defaultCl.id);
      expect(files).toHaveLength(1);
      expect(files[0].relativePath).toBe('src/a.ts');
    });

    it('should work across multiple changelists', () => {
      const defaultCl = manager.getDefault();
      const cl = manager.create('Feature1');

      manager.addFile(defaultCl.id, 'src/a.ts');
      manager.addFile(cl.id, 'src/b.ts');

      const dirty = new Set<string>(); // nothing is dirty
      manager.removeCleanFiles(dirty);

      expect(manager.getFilesForChangelist(defaultCl.id)).toHaveLength(0);
      expect(manager.getFilesForChangelist(cl.id)).toHaveLength(0);
    });
  });

  describe('events', () => {
    it('should fire onDidChange when changelist is created', () => {
      const listener = vi.fn();
      manager.onDidChange(listener);

      manager.create('Feature1');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should fire onDidChange when file is added', () => {
      const listener = vi.fn();
      manager.onDidChange(listener);

      manager.addFile(manager.getDefault().id, 'src/a.ts');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should fire onDidChangeActiveList when active changes', () => {
      const listener = vi.fn();
      manager.onDidChangeActiveList(listener);

      const cl = manager.create('Feature1');
      manager.setActive(cl.id);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(cl);
    });
  });
});
