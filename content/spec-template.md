---
title: "SPEC-TEMPLATE"
feature: "[Feature Name]"
status: draft
created: "[YYYY-MM-DD]"
updated: "[YYYY-MM-DD]"
author: "[Your name]"
reviewers: []
spec-level: 1
---

<!--
  SPEC-TEMPLATE.md · Feature Specification Template
  ───────────────────────────────────────────────────
  Copy to: specs/features/{feature-slug}.md
  Replace [PLACEHOLDERS]. Delete comments before sharing.

  This file answers WHAT to build (feature-scoped).
  HOW to work (conventions, commands, boundaries) lives in AGENTS.md.

  Approval gate: set status → approved before any code is written.
  Context hygiene: keep the filled spec under ~200 lines. Split if larger.

  Status values: draft | in-review | approved | in-progress | done
  spec-level: 1 = spec-first (discard after) · 2 = spec-anchored (lives with code)
-->

# [Feature Name]

> **Status:** `draft` — not approved for implementation.

---

## 1. Overview

<!-- 3–5 sentences max. If you can't answer all three, the scope is too large — split the spec. -->

**What:** [What is being built, in plain language.]

**Why:** [The user pain or business driver this solves.]

**Done when:** [One-sentence observable north star.]

---

## 2. User Stories

<!-- Format: As a [persona], I want [goal], so that [benefit].
     "So that" is mandatory. 3–7 stories. More = scope creep. -->

| # | Persona | I want to… | So that… | Priority |
|---|---------|-----------|----------|----------|
| US-01 | [persona] | [goal] | [benefit] | Must |
| US-02 | [persona] | [goal] | [benefit] | Should |
| US-03 | [persona] | [goal] | [benefit] | Could |

<!-- Priority: Must / Should / Could -->

---

## 3. Acceptance Criteria

<!-- GIVEN / WHEN / THEN. Each AC must be independently testable (pass/fail, not subjective).
     Cover at least one happy path + one failure path per story.
     Agents reference these numbers — be precise.

     ✅ GIVEN a logged-in user WHEN they submit a blank form THEN an inline validation error appears.
     ❌ "The form should validate inputs." — not testable. -->

**AC-01** · US-01 — Happy path
> GIVEN [state] WHEN [action] THEN [outcome]

**AC-02** · US-01 — Failure path
> GIVEN [state] WHEN [error condition] THEN [expected behaviour]

**AC-03** · US-02 — Happy path
> GIVEN [state] WHEN [action] THEN [outcome]

---

## 4. Architecture Notes

<!-- Scoped to this feature only. Don't copy project-wide architecture here.
     Link to ADRs; don't replicate them. 10–15 lines max. -->

- **Components touched:** [list affected services/modules]
- **Data model changes:** [new tables, fields, migrations — or "none"]
- **New dependencies:** [libraries or APIs introduced — or "none"]
- **Key constraints:** [non-obvious decisions an agent must not override]

---

## 5. Out of Scope

<!-- As important as what IS in scope. Prevents agents from over-building. -->

- [Related item deferred to a future spec]
- [Responsibility of another team or system]
- [Deliberate simplification for this iteration]

---

## 6. Tasks

<!-- Each task = one focused agent session. Order by dependency.
     Layer prefixes: [DB] [API] [UI] [TEST] [INFRA] [DOCS]
     Status: [ ] not started · [~] in progress · [x] done -->

| # | Task | Layer | Satisfies |  |
|---|------|-------|-----------|--|
| T-01 | [Atomic unit of work] | [layer] | AC-01 | [ ] |
| T-02 | [Next unit] | [layer] | AC-02 | [ ] |
| T-03 | Write tests for T-01, T-02 | TEST | All | [ ] |
| T-04 | [Next unit] | [layer] | AC-03 | [ ] |

---

## 7. Open Questions

<!-- Must be resolved before status → approved. -->

| # | Question | Owner | Resolved |
|---|----------|-------|----------|
| Q-01 | [Blocking question] | [@person] | — |

---

## 8. Changelog

| Date | Change |
|------|--------|
| [YYYY-MM-DD] | Initial draft |