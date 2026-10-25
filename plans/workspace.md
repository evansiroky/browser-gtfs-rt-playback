---
status: planned
depends: []
specs:
  - specs/architecture.md
  - specs/api/conventions.md
  - specs/api/session.md
  - specs/api/dashboard.md
  - specs/api/trips.md
  - specs/api/shapes.md
issues: []
---

# Plan: Workspace and shared contract

## Scope
In: the repository's TypeScript workspace and toolchain, the `shared` package (API contract
types + the polyline codec), a root `README.md`, `.gitignore`.

Out: the `server`, `web`, `fixtures`, and `e2e` packages — each is created by the plan that
owns it ([`server-core`](server-core.md), [`web-shell`](web-shell.md),
[`test-fixtures`](test-fixtures.md), [`dashboard-screen`](dashboard-screen.md)); Dockerfile
([`container-image`](container-image.md)); CI ([`ci-cd`](ci-cd.md)).

## Implements
- `specs/architecture.md` "Stack" and "Repository structure": TypeScript end to end, npm,
  shared API types, Vitest.
- `specs/api/*.md`: the request/response shapes become TypeScript types in `shared`, exactly as
  specified (field names, nullability, enums, error codes).
- `specs/data-model.md` "Shape": the precision-6 encoded polyline codec.

## Approach
1. Root `package.json` with `"private": true`, `"type": "module"`, `engines.node >= 22`, and
   `workspaces: ["shared", "fixtures", "server", "web", "e2e"]` (missing directories are fine;
   later plans add them — **order matters**: it is the build order). Root scripts, each
   delegating with `--workspaces --if-present`: `lint`, `typecheck`, `test`, `build`, plus
   `format`/`format:check` (Prettier).
2. `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, ESM, target ES2023); TypeScript
   project references so dependents typecheck against `shared`'s built output.
3. ESLint v9 flat config at the root (typescript-eslint, applies to every package), Prettier
   config, `.editorconfig`, `.nvmrc` (22), `.gitignore` (node_modules, dist, coverage, .env*).
4. `shared/`: `src/api.ts` (all API types named after the specs: `SessionStatus`, `FeedStatus`,
   `DashboardResponse`, `TripListResponse`/`TripListItem`, `TripDetailResponse`, `Ping`,
   `ShapeResponse`, `ApiErrorBody`, the `ListName` and `TripReason` unions, error-code union),
   `src/polyline.ts` (`encodePolyline6`, `decodePolyline6`), `src/index.ts`. Built to `dist`
   with declarations; Vitest tests.
5. Root `README.md`: what the project is, repo layout, dev commands (filled in further by later
   plans), pointer to `specs/`.

## Validation
- [ ] From a clean checkout: `npm ci && npm run lint && npm run typecheck && npm test && npm run build` passes.
- [ ] Every type in `shared/src/api.ts` is traceable to a spec section; a reviewer diffing
      `specs/api/*.md` against it finds no missing field, wrong nullability, or extra field.
- [ ] Polyline codec: known Google test vectors (scaled for precision 6) encode and decode
      correctly; round-trip of random points within ±0.0000005° tolerance; empty and
      single-point inputs; negative coordinates; large values.
- [ ] `npm run format:check` passes; `.gitignore` excludes build output and `node_modules`.
- [ ] `npm ls` shows no duplicate TypeScript/ESLint versions across workspaces.

## Risks / unknowns
- **Workspace order vs. later packages** — later plans must append to `workspaces` in the
  documented order; the README says so.
- **Project references friction** — if they prove awkward, a `build` that runs `tsc -b` in
  dependency order is acceptable as long as dependents typecheck against `shared`'s output.

## Notes
(Populated at closeout.)

## Follow-ups
(Populated at closeout.)
