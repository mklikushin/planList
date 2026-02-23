# Cursor Plans Quick Pick

This extension adds a command that lists plan files from `~/.cursor/plans` and opens the selected file in the current Cursor/VS Code window.

## Command

- `Cursor Plans: List Plans` (`cursorPlans.listPlans`)

## Behavior

- Reads plan files from `~/.cursor/plans` with the `.plan.md` suffix.
- Sorts entries newest-to-oldest using file modification time.
- Groups entries by local date using Quick Pick separators.
- Opens the selected file with `openTextDocument` + `showTextDocument`.

## Caching and incremental updates

- Maintains an in-memory path map and sorted record list after first load.
- Reuses cached Quick Pick results on repeated runs when no file changes are detected.
- Tracks add/update/remove events with `fs.watch` and applies per-file diffs without full resort.
- Falls back to full rebuild when watcher events are incomplete or watcher errors occur.

## Missing folder behavior

- If `~/.cursor/plans` does not exist, the command shows an informational message and exits gracefully.
