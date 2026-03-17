export interface ChangelistFile {
  /** Workspace-relative file path */
  relativePath: string;
  /** Timestamp when file was added to this changelist */
  addedAt: number;
}

export interface Changelist {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Whether this is the currently active changelist */
  isActive: boolean;
  /** Whether this is the default "Changes" changelist (cannot be deleted) */
  isDefault: boolean;
  /** Files assigned to this changelist */
  files: ChangelistFile[];
}

export interface ChangelistState {
  /** All changelists */
  changelists: Changelist[];
  /** Version for future migration support */
  version: number;
}

export const DEFAULT_CHANGELIST_NAME = 'Changes';
export const STATE_VERSION = 1;
