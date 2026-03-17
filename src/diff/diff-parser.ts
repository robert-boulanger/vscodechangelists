import { FileDiff, Hunk } from './types';

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parses unified diff output (`git diff`) into structured FileDiff objects.
 */
export function parseDiff(diffOutput: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = diffOutput.split('\n');

  let currentFile: FileDiff | undefined;
  let currentHunk: { header: string; lines: string[] } | undefined;
  let hunkCounter = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New file diff starts with "diff --git"
    if (line.startsWith('diff --git ')) {
      // Flush previous hunk
      if (currentFile && currentHunk) {
        finishHunk(currentFile, currentHunk, hunkCounter++);
      }
      currentHunk = undefined;

      const filePath = extractFilePath(line);
      currentFile = {
        filePath,
        headerLines: [line],
        hunks: [],
      };
      files.push(currentFile);
      continue;
    }

    if (!currentFile) continue;

    // File header lines (index, ---, +++)
    if (
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('old mode ') ||
      line.startsWith('new mode ') ||
      line.startsWith('new file mode ') ||
      line.startsWith('deleted file mode ') ||
      line.startsWith('similarity index ') ||
      line.startsWith('rename from ') ||
      line.startsWith('rename to ') ||
      line.startsWith('Binary files ')
    ) {
      currentFile.headerLines.push(line);
      continue;
    }

    // Hunk header
    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      // Flush previous hunk
      if (currentHunk) {
        finishHunk(currentFile, currentHunk, hunkCounter++);
      }
      currentHunk = { header: line, lines: [] };
      continue;
    }

    // Hunk content lines (+, -, space, or \ No newline at end of file)
    if (currentHunk) {
      currentHunk.lines.push(line);
    }
  }

  // Flush last hunk
  if (currentFile && currentHunk) {
    finishHunk(currentFile, currentHunk, hunkCounter++);
  }

  return files;
}

function finishHunk(file: FileDiff, raw: { header: string; lines: string[] }, _counter: number): void {
  const match = raw.header.match(HUNK_HEADER_RE);
  if (!match) return;

  const oldStart = parseInt(match[1], 10);
  const oldLines = match[2] !== undefined ? parseInt(match[2], 10) : 1;
  const newStart = parseInt(match[3], 10);
  const newLines = match[4] !== undefined ? parseInt(match[4], 10) : 1;

  const content = raw.lines.join('\n');
  const summary = extractSummary(raw.lines);

  // Fingerprint: only the changed (+/-) lines — stable across context/line shifts
  const changedLines = raw.lines
    .filter(l => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
    .join('\n');
  const fingerprint = `${file.filePath}:${simpleHash(changedLines)}`;

  // ID uses full content (context + changes) for uniqueness within a single parse
  const id = `hunk_${file.filePath}_${simpleHash(content)}`;

  const hunk: Hunk = {
    id,
    filePath: file.filePath,
    oldStart,
    oldLines,
    newStart,
    newLines,
    header: raw.header,
    content,
    summary,
    fingerprint,
  };

  file.hunks.push(hunk);
}

/** Fast, deterministic string hash (djb2) */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function extractSummary(lines: string[]): string {
  // Prefer added (+) lines over removed (-) lines for summary
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return line.slice(1).trim();
    }
  }
  for (const line of lines) {
    if (line.startsWith('-') && !line.startsWith('---')) {
      return line.slice(1).trim();
    }
  }
  return '(no changes)';
}

function extractFilePath(diffGitLine: string): string {
  // "diff --git a/path/to/file b/path/to/file"
  const match = diffGitLine.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (match) {
    return match[2]; // Use b-side path (handles renames)
  }
  return diffGitLine.replace('diff --git ', '');
}

/**
 * Builds a valid unified diff patch from a FileDiff and a subset of its hunks.
 * The patch can be applied with `git apply --cached`.
 */
export function buildPatch(file: FileDiff, hunks: Hunk[]): string {
  if (hunks.length === 0) return '';

  const lines: string[] = [...file.headerLines];

  for (const hunk of hunks) {
    lines.push(hunk.header);
    lines.push(hunk.content);
  }

  // Ensure trailing newline
  return lines.join('\n') + '\n';
}
