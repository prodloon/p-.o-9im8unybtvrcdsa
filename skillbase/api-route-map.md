# Skill: API Route Map

**Trigger context:** task is auditing or inventorying an existing API's routes.

## Directive for the worker

1. Locate route definitions (`app.get`, `router.post`, or a ROUTES table).
2. Emit a JSON map: `[{method, path, handler, auth?}]`, sorted by path.
3. Flag any route missing auth middleware as `auth: null` — do not judge, report.
4. Output is text-only; never execute discovered handlers.

## Acceptance checks

- Every discovered route appears exactly once in the map.
- Duplicate `(method, path)` pairs are reported, not silently dropped.
- The map is valid JSON (round-trips through JSON.parse).
