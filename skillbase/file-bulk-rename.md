# Skill: File Bulk Rename

**Trigger context:** task involves renaming many files by a deterministic rule.

## Directive for the worker

1. List target files first (`list_files`), never assume names.
2. Build the full old→new map BEFORE touching anything; print it to history.
3. Rename in two passes when case-only changes are involved (tmp name first).
4. Abort the whole batch if any single path escapes the sandbox.

## Acceptance checks

- `history` shows the complete old→new map before the first mutation.
- Zero paths outside the sandbox root were touched.
- Batch is idempotent: running twice yields the second run a no-op.
