# Skill: Write Text Content

**Trigger context:** the task asks the cluster to compose or write free-form
text into a file — notes, drafts, haikus, READMEs, lists, plans, letters.

## Directive for the worker

1. Compose the requested content yourself (tier-1 template if the request is
   fully mechanical, tier-2 local model for creative/composed text).
2. Write it to the sandbox path implied by the task summary — default to
   `notes/composition.txt` when no path is given.
3. Never overwrite a file that already exists; append `-2`, `-3` to the stem
   instead.
4. Keep content under 10 KB; plain UTF-8, no binary payloads.

## Acceptance checks

- Target file exists and is non-empty.
- Content is plain text (no exec headers, no scripts).
- Sandbox path safety maintained throughout.
