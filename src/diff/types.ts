export interface Hunk {
  /** Unique identifier */
  id: string;
  /** Workspace-relative file path */
  filePath: string;
  /** Start line in the original file (a-side) */
  oldStart: number;
  /** Number of lines in the original (a-side) */
  oldLines: number;
  /** Start line in the modified file (b-side) */
  newStart: number;
  /** Number of lines in the modified (b-side) */
  newLines: number;
  /** The raw hunk content including +/- lines and context */
  content: string;
  /** The hunk header line (e.g. @@ -1,5 +1,7 @@) */
  header: string;
  /** Optional: changelist ID this hunk is assigned to */
  changelistId?: string;
  /** Human-readable summary (first changed line) */
  summary: string;
  /** Fingerprint of changed (+/-) lines only — stable across context shifts */
  fingerprint: string;
}

export interface FileDiff {
  /** Workspace-relative file path */
  filePath: string;
  /** The full diff header (--- a/... +++ b/...) */
  headerLines: string[];
  /** Individual hunks in this file */
  hunks: Hunk[];
}
