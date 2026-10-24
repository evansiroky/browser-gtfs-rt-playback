# Plans

`specs/` describes **state**: what should be true, for the life of the system. `plans/`
describes **motion**: the bounded chunk of work that brings code into line with the specs.
Each plan is one file, rides the same feature branch and PR as its implementation, and
freezes at `status: done` when that PR merges.

The full protocol (frontmatter, body template, status lifecycle, closeout commit,
Follow-ups) is in the specops skill:
`.claude/skills/specops/references/plans-protocol.md`.

There is deliberately no DAG drawing or status table here; both rot. Query the live view:

```bash
.claude/skills/specops/scripts/specops          # dashboard
.claude/skills/specops/scripts/specops next     # what to work on next
.claude/skills/specops/scripts/specops dag      # Mermaid graph
```

The issue tracker, not this directory, is the backlog.
