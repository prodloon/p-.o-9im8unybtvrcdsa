# Skill: Code Explainer

**Trigger context:** the task asks to explain, summarize, or document code —
what a file does, how a function works, produce a README summary of a module.

## Directive for the worker

1. Read the target file(s) inside the sandbox (never outside it).
2. Produce a short explanation: purpose, key functions, inputs/outputs,
   gotchas. Prefer bullet points over prose walls.
3. Return the explanation as the task output; if the task asks for a file,
   write it next to the target as `<name>.NOTES.md`.
4. Do not modify the explained file.

## Acceptance checks

- Explanation is non-empty and references real identifiers from the file.
- No writes outside the sandbox.
- The target file is byte-identical before and after.
