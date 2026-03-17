# Changelists for VSCode

JetBrains-style changelists for Visual Studio Code. Organize your uncommitted changes into logical groups and commit them independently — even different parts of the same file.

## Features

### Changelist Management
- Create multiple named changelists to organize your work
- One changelist is always active — new changes are automatically assigned to it
- Default "Changes" changelist is always present (like JetBrains)
- Switch active changelist with a single click
- Rename and delete changelists as needed

### Hunk-Level Tracking
- **The killer feature**: Split changes within the same file across different changelists
- Each hunk (block of changes) can be independently assigned to any changelist
- Drag-and-drop hunks between changelists in the tree view
- Commit only specific hunks — the rest stays in your working tree
- Colored gutter markers show which changelist each change belongs to

### Independent Commits
- Commit any changelist independently, regardless of order
- File-level commits: stage entire files from a changelist
- Hunk-level commits: stage only specific hunks using `git apply --cached`
- Remaining changes in other changelists are preserved

### Ticket Integration
- Connect to **Jira Cloud** or **GitHub Issues**
- When creating a new changelist, search and select from your open tickets
- Ticket title becomes the changelist name (e.g., "PROJ-123: Fix login bug")
- Client-side filtering for instant search

### Tree View with Drag-and-Drop
- Dedicated panel in the Source Control sidebar
- Changelists shown as groups with files as children
- Files with multiple hunks are expandable, showing individual hunks
- Drag-and-drop files and hunks between changelists
- Context menus for all operations (commit, rename, delete, move)

### Gutter Decorations
- Colored markers in the editor gutter next to changed lines
- Each changelist has a unique color
- Instantly see which changelist a change belongs to
- Click the gutter marker to open the diff and move changes between changelists

### Status Bar
- Shows the currently active changelist in the status bar
- Click to quickly switch the active changelist

## Getting Started

1. Install the extension
2. Open a Git repository in VSCode
3. The "Changelists" panel appears in the Source Control sidebar
4. Start editing files — changes are automatically tracked in the active changelist
5. Create new changelists with the `+` button to organize your work

## Workflow Example

1. Create changelist **"Feature: Auth"**
2. Edit `auth.ts` line 10 and `config.ts`
3. Create changelist **"Bugfix: Login"**
4. Edit `auth.ts` line 80 (same file, different location!)
5. Commit **"Bugfix: Login"** — only the line 80 change is committed
6. Commit **"Feature: Auth"** — the line 10 change and `config.ts` are committed

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| `Changelist: New` | Create a new changelist |
| `Changelist: Delete` | Delete a changelist (files move to default) |
| `Changelist: Rename` | Rename a changelist |
| `Changelist: Set Active` | Set the active changelist |
| `Changelist: Commit` | Commit all changes in a changelist |
| `Changelist: Move to...` | Move a file/hunk to another changelist |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `changelists.autoTrackChanges` | `true` | Automatically assign changed files to the active changelist |
| `changelists.pollInterval` | `3000` | Interval (ms) for polling git changes |
| `changelists.removeEmptyChangelistAfterCommit` | `false` | Auto-remove empty changelists after commit |
| `changelists.ticketProvider` | `"none"` | Ticket provider: `"none"`, `"jira"`, or `"github"` |

### Jira Configuration

| Setting | Description |
|---------|-------------|
| `changelists.jira.baseUrl` | Jira Cloud URL (e.g., `https://mycompany.atlassian.net`) |
| `changelists.jira.email` | Jira account email |
| `changelists.jira.token` | Jira API token |
| `changelists.jira.projectKey` | Project key for filtering (e.g., `PROJ`) |

### GitHub Configuration

| Setting | Description |
|---------|-------------|
| `changelists.github.token` | GitHub personal access token |
| `changelists.github.owner` | Repository owner |
| `changelists.github.repo` | Repository name |

## How It Works

### File-Level Tracking
Changed files are automatically detected via `git status` polling and assigned to the active changelist. Files can be moved between changelists via drag-and-drop or context menu.

### Hunk-Level Tracking
When a file has changes at multiple locations, each "hunk" (contiguous block of changes) can be independently assigned to different changelists. During commit, only the assigned hunks are staged using `git apply --cached` with targeted patches.

### Persistence
Changelist state is saved in `.vscode/changelists.json` (workspace-local). Hunk assignments are tracked in memory and re-matched after each git operation using content-based fingerprinting.

## Known Limitations

- Hunks must be at least ~7 lines apart (Git merges closer hunks into one)
- The native VSCode commit button cannot be intercepted (use the changelist commit command instead)
- Single-workspace only (no multi-root workspace support yet)

## License

MIT
