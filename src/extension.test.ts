import { describe, it, expect } from 'vitest';

describe('Extension', () => {
  it('should export activate function', async () => {
    const ext = await import('./extension');
    expect(ext.activate).toBeDefined();
    expect(typeof ext.activate).toBe('function');
  });

  it('should export deactivate function', async () => {
    const ext = await import('./extension');
    expect(ext.deactivate).toBeDefined();
    expect(typeof ext.deactivate).toBe('function');
  });
});
