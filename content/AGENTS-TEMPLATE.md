<!--
  AGENTS-TEMPLATE.md · Universal Agent Instruction File Template
  ──────────────────────────────────────────────────────────────
  Copy this to your project root as AGENTS.md (works across Claude Code,
  Cursor, GitHub Copilot, Gemini CLI, Windsurf).

  Rules for filling this in:
  · Replace [PLACEHOLDERS]. Delete guidance comments before committing.
  · Target: < 150 lines when filled in. If it grows longer, move content
    to linked docs and point here. More rules ≠ better adherence.
  · This file answers HOW to work — not WHAT to build.
    Feature requirements live in specs/features/*.md, not here.
-->

# AGENTS.md — [Project Name]

## Project

[One sentence: what this system does and who it serves.]

- Stack: [e.g., TypeScript / Next.js 15 / Postgres]
- Architecture overview: `docs/architecture.md`
- Feature specs: `specs/features/`

---

## Commands

<!-- Exact commands with all flags. This eliminates the #1 cause of agent errors. -->

```bash
# Install
[e.g., npm install]

# Dev server
[e.g., npm run dev]

# Tests (all)
[e.g., npm test]

# Tests (single file)
[e.g., npm test -- path/to/file.test.ts]

# Lint + format
[e.g., npm run lint]

# Type check
[e.g., npm run typecheck]
```

> Requires: [e.g., `.env.local` — see `.env.example`]

---

## Structure

<!-- One line per key directory. Only what's non-obvious. -->

```
[src/]
├── [folder/]   ← [what lives here]
├── [folder/]   ← [what lives here]
└── [folder/]   ← [what lives here]
```

---

## Code Conventions

<!-- One concrete example beats three paragraphs. Only document what's project-specific
     and non-obvious. Don't repeat what the linter enforces automatically. -->

- Language version: [e.g., TypeScript 5.x strict mode]
- Naming: [e.g., files: kebab-case · functions: camelCase · components: PascalCase]
- Tests: [e.g., co-located *.test.ts · integration tests preferred for API routes]

```[language]
// ✅ [show the preferred pattern with a real project example]

// ❌ [show what NOT to do]
```

---

## Boundaries

<!-- Most critical section. Be explicit and specific. -->

**Always do** (no approval needed)
- Run tests after every code change
- Read existing code before modifying it
- [Add 2–3 project-specific safe defaults]

**Ask first** (stop, explain intent, wait for approval)
- Schema changes · new dependencies · auth/authz changes
- Refactoring outside the current task scope
- [Add project-specific sensitive actions]

**Never do** (hard stops, no exceptions)
- Commit secrets, API keys, or credentials
- Push directly to `main` or `master`
- Disable or skip tests (`--no-verify`, `skip()`, `xit()`)
- Touch production data or deployments
- [Add project-specific hard stops]

---

## Spec Workflow

When a feature spec exists in `specs/features/`:
1. Read it fully before writing any code
2. Spec `status` must be `approved` before implementation starts
3. Acceptance criteria (AC-XX) are your definition of done
4. If spec and codebase conflict — stop and flag it; do not assume

---

## For Details, See

<!-- Use progressive disclosure. Link to docs rather than inlining them. -->

| Topic | Location |
|-------|----------|
| Architecture decisions | `docs/architecture.md` |
| [Other topic] | `[path]` |

<!--
  Maintenance: review monthly or after tooling changes.
  Owner: [Tech lead / designated person]
  A focused file followed consistently > a comprehensive one ignored.
-->