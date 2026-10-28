---
status: done
pr: 3
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
- [x] From a clean checkout: `npm ci && npm run lint && npm run typecheck && npm test && npm run build` passes.
- [x] Every type in `shared/src/api.ts` is traceable to a spec section; a reviewer diffing
      `specs/api/*.md` against it finds no missing field, wrong nullability, or extra field.
- [x] Polyline codec: known Google test vectors (scaled for precision 6) encode and decode
      correctly; round-trip of random points within half a microdegree plus 1e-9
      floating-point slack; empty and single-point inputs; negative coordinates; large values.
- [x] `npm run format:check` passes; `.gitignore` excludes build output and `node_modules`.
- [x] `npm ls` shows no duplicate TypeScript/ESLint versions across workspaces.

## Risks / unknowns
- **Workspace order vs. later packages** — later plans must append to `workspaces` in the
  documented order; the README says so.
- **Project references friction** — if they prove awkward, a `build` that runs `tsc -b` in
  dependency order is acceptable as long as dependents typecheck against `shared`'s output.

## Notes
- **Versions.** TypeScript `~5.9.3` (not 7.x: typescript-eslint 8 does not support it), ESLint `^9.39.5`
  with `@eslint/js` and `typescript-eslint ^8.72.0`, Prettier `^3.9.10`, **Vitest `^5.0.5`**,
  `@types/node ^22`. All dev dependencies are declared once in the root `package.json`; `npm ls`
  shows a single TypeScript (5.9.3) and a single ESLint (9.39.5). `engines.node` is `>=22.12`
  (vitest 5 and vite 8 require it).
- **Vitest decision.** Vitest 3.2.7 pulled in `tinypool <=2.1.1` (critical: GHSA-5gmw-xhrv-c9v3 and
  GHSA-85c8-ppgw-ccpr, prototype-pollution gadget to RCE via worker options) and `@vitest/mocker
  <=4.1.11` (moderate: GHSA-82fw-gwwq-j7x9 and GHSA-qxg6-89mg-rqv8). Upgrading to 5.0.5 (vite 8.3.5)
  was clean on Node 22 with the TypeScript 5.9 pin: all tests, including typecheck mode, pass, and
  `npm audit` reports 0 vulnerabilities. Later plans use this version.
- **Module resolution.** `tsconfig.base.json` uses `NodeNext`, so relative imports carry `.js`
  extensions. `web` may override `module`/`moduleResolution` to `ESNext`/`Bundler` for Vite.
- **Build output and self-sufficient scripts.** `shared` is a composite project consumed through
  `exports` at `dist`. Its `tsBuildInfoFile` is `dist/.tsbuildinfo`, so deleting `dist` always
  forces a rebuild (previously the buildinfo sat outside `dist` and `tsc -b` silently emitted
  nothing). Its `typecheck`, `test` and `build` scripts all start with `tsc -b`, and `shared` is
  first in the workspace order, so root `npm test` and `npm run typecheck` work in a clean
  checkout and dependents can import the built package. Root `npm run clean` removes `dist` from
  every workspace. Verified from a clean clone: `npm ci && npm test` with only `shared` present, and
  with a scratch stub `server` package that imports `@gtfs-rt-debugger/shared` (test and typecheck),
  both after `rm -rf shared/dist`.
- **Type tests.** `shared/src/api.test-d.ts` pins each exported shape as a whole object literal with
  `expectTypeOf(...).toEqualTypeOf`, plus `EpochSeconds`, `ServiceDate` and the runtime constant
  tuples. It runs under Vitest typecheck mode (`npm test`) and `npm run typecheck`. Mutations of
  `shared/src/api.ts` that each fail `vitest run` (all 20 confirmed): `Ping.speed`,
  `Ping.vehicleLabel`, `Ping.occupancyPercentage` (string), `Ping.receivedAt` (string),
  `FeedStatus.lastAttemptAt`, `SessionStatus.schedule.loadedAt`, `TripListItem.headsign`,
  `TripUpdateSummary.delay`, `TripClassification.start`, `SessionStatus.realtime.tripUpdates` made
  non-null; `ServiceDate = number`; `Ping.speed`, `FeedStatus.lastSuccessAt`,
  `TripScheduleDetail.shapeId` made optional; an extra field on `ShapeResponse`;
  `DashboardResponse.agency.timezone` removed; a `TripReason` member removed; an `ApiErrorCode`
  member removed; `TripListResponse.list: string`; `ShapeResponse.encoding: string`.
- **Deviations from the literal spec text.** `TripListResponse.list` is `ListName` rather than
  `string` (the spec says "echo of the parameter", and an unknown value is a 400). `Ping` does not
  type the pass-through `VehiclePosition` fields (conventions: clients ignore unknown fields);
  the trip-detail screen reads extras via `Object.entries`. Runtime `as const` arrays
  (`API_ERROR_CODES`, `LIST_NAMES`, `TRIP_REASONS`, `CONFIGURATION_ERROR_CODES`) back the unions so
  the server can validate the `list` parameter without redefining them. `StatusError.code` is a
  free string (feed-ingest codes such as `http_status_404`), distinct from `ApiErrorCode`.
- **Polyline codec.** Arithmetic instead of bit operations so values beyond 32 bits stay exact
  (tested to 1e7 degrees). Deltas are taken on rounded integers, so rounding error never
  accumulates. `encodePolyline6` throws `RangeError` on non-finite coordinates. `decodePolyline6`
  throws on truncated or invalid input, on any value longer than 10 five-bit chunks (50 bits, which
  also keeps every decoded integer exact; runaway inputs such as `'_'*205 + '??'` and
  `'~'*20 + '??'` used to decode to NaN, Infinity or ~1e144), and on a non-finite result (a
  defensive guard: the chunk cap already makes it unreachable). Test vectors: the Google example
  re-derived at precision 6 by an independent reference encoder in the test file, checked against
  the documented precision-5 string.
- **Prettier scope.** `specs/`, `plans/` and `CLAUDE.md` are in `.prettierignore` so authored
  markdown is not reformatted by `format`.
- 37 tests (22 runtime, 15 type) pass; `npm ci` and the full toolchain verified from a fresh clone
  of the branch.

## Follow-ups
None.
