# Skill: Scaffold Express API

**Trigger context:** task involves scaffolding a new Node/Express REST API.

## Directive for the worker

1. Create directory `src/routes/`, `src/middleware/`, `src/controllers/`.
2. Write `package.json` with `express` in dependencies, `"start": "node src/index.js"`.
3. Write `src/index.js` with a health route `GET /health -> {ok:true}`.
4. One route file per resource; keep handlers synchronous and deterministic.
5. Never start the server from inside the worker — scaffold files only.

## Acceptance checks

- `src/index.js` exists and parses (`node --check`).
- No hardcoded secrets in any generated file.
- Sandbox path safety maintained throughout.
