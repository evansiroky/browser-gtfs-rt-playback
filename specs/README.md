# Specs

`specs/` declares what gtfs-rt-debugger *should* do. It is authoritative for the
life of the system: implementation is brought into conformance with it, and spec↔code drift
is a bug. Work in flight lives in [`plans/`](../plans/README.md); the issue tracker is the
backlog. The full methodology is in the specops skill (`.claude/skills/specops/SKILL.md`).

## Layout

```
specs/
├── README.md          # this file
├── principles.md      # project-wide principles: decisive rules that resolve unspecified decisions
├── architecture.md    # tech stack, project structure, foundational decisions
├── data-model.md      # shared concepts: service date, schedule entry, shape, snapshot, ping
├── infrastructure.md  # GCP resources, Terraform, bootstrap/teardown scripts, cost guards
├── deployment.md      # CI/CD: how code and infra reach the single environment
├── api/               # one file per endpoint group; conventions.md for shared rules
├── screens/           # one file per screen/route
└── behaviors/         # cross-cutting rules: configuration, session lifecycle, client
                       #   activity, feed ingest, retention, trip activity
```

## Conventions

- Specs say **what** must be true, not **how** to build it: no component decomposition,
  file paths, visual design, or test cases.
- A principle local to one spec goes in that spec's `## Principles` section; promote it to
  `principles.md` when it governs decisions beyond that file, and link down from the specs it
  governs.
- A change to behavior is a `docs(specs):` commit first, then the plan, then the
  implementation, all on one feature branch and one PR. No spec-only PRs.
- A spec on the main branch is either implemented or covered by a committed plan.
- Spec templates (screen, behavior, API, principles) are in the skill's `SKILL.md`.
