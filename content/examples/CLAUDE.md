# CLAUDE.md

Supplier Master Data Validation System — FastAPI backend + React frontend for validating supplier data, detecting duplicates, and managing validation workflows (VAT, IBAN, name/address via LLM, duplicate detection).

> This is a living document. Update it when you discover non-obvious behaviors, change tooling, or establish new conventions.

## Commands

### Backend — use `uv` for ALL Python commands, never `pip`

```bash
uv sync                                                        # install/sync deps
docker-compose up -d                                           # start Postgres, Redis, SearXNG
uv run alembic upgrade head                                    # apply migrations
uv run uvicorn src.api.main:app --reload --host 0.0.0.0 --port 8000  # dev server
uv run pytest                                                  # run tests
uv run pytest --cov=. --cov-report=term-missing                # with coverage
uv run black . && uv run isort .                               # format
uv run mypy .                                                  # type check
uv run python scripts/<script>.py                              # run utility script
uv add <package>                                               # add dependency
uv add --dev <package>                                         # add dev dependency
```

### Frontend

```bash
cd frontend
npm install          # install deps (use npm, not yarn/pnpm)
npm run dev          # dev server with hot reload
npm run build        # production build
npm run lint         # lint
```

### Database

```bash
psql postgresql://eon_user:changeme@localhost:5432/eon_vmd     # connect
uv run alembic revision --autogenerate -m "description"        # create migration
uv run alembic upgrade head                                    # apply
uv run alembic downgrade -1                                    # revert one
uv run alembic history && uv run alembic current               # inspect
```

### Docker

```bash
docker-compose up -d                   # start all services
docker-compose down                    # stop
docker-compose down -v                 # stop + destroy volumes (DELETES DATA)
docker-compose logs -f backend         # tail backend logs
docker-compose restart backend         # restart a service
```

## Architecture

### Backend (`src/`)

```
api/            FastAPI routes, HTTP Basic auth (auth.py), DI (dependencies.py)
core/           job_manager.py — ValidationJobManager orchestrates background jobs
db/             models.py (20+ tables), repositories/ (data access layer), migrations/
validators/     vat_validator.py, iban_validator.py, name_address_validator.py, duplicate_detector.py
```

### Frontend (`frontend/src/`)

```
services/api.ts        Axios client — ALL API calls go through here (auth interceptors)
contexts/              AuthContext (creds in localStorage), JobContext (polls job status)
components/ui/         Shared primitives (Button, Card, Table, etc.)
pages/                 LoginPage, ValidationTriggerPage, ValidationStatusPage
```

### Key Patterns

- **Async everywhere**: All DB ops use `async/await` with `AsyncSession` — never mix sync SQLAlchemy
- **Repository pattern**: Data access isolated in `db/repositories/` — add methods there, not in routes
- **Validation caching**: Every validator checks its Postgres cache table before calling external APIs
- **Job lifecycle**: PENDING → RUNNING → COMPLETED / FAILED / CANCELLED

## Code Conventions

### Python

- API endpoints: inject DB with `Depends(get_db_session)` from `src/api/dependencies`
- Background jobs: create their own `async with AsyncSessionLocal() as session` — **NEVER share sessions across async tasks**
- Validators: accept `db_session` in `__init__`; implement caching against the relevant `*_validations` table

### TypeScript / React

- Never call `fetch` or `axios` directly in components — use functions from `services/api.ts`
- Auth: use `useAuth()` hook from `contexts/AuthContext`
- Tables: use `@tanstack/react-table` (already used throughout; keep consistent)

## Critical Gotchas

1. **Session sharing**: NEVER pass `AsyncSession` between async tasks or background jobs. Each job must create its own session.
2. **Alembic blind spots**: autogenerate does NOT detect table renames, compatible column type changes, or enum changes. Always review generated migrations before applying.
3. **Migration conflicts**: `git pull` before creating new migrations to avoid conflicts.
4. **Cascade deletes**: `suppliers` table cascades to all child tables (VAT IDs, IBANs, companies, validations). Deleting a supplier removes everything.
5. **Force re-validation**: Use `force_fresh=True` on validators when business rules change; stale cache will otherwise be used.

## Visual Development

After **any** frontend change, IMMEDIATELY:

1. Navigate to changed pages with `mcp__playwright__browser_navigate`
2. Compare against `/context/design-principles.md` and `/context/style-guide.md`
3. Screenshot at 1440px desktop viewport
4. Check console errors with `mcp__playwright__browser_console_messages`

## Environment Variables

See `.env` for values. Required:

```
DATABASE_URL                                    # PostgreSQL DSN
POSTGRES_HOST / POSTGRES_PORT / POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD
SEARXNG_URL                                     # default: http://localhost:8080
OPENAI_API_KEY                                  # LLM-based name/address validation
VATSENSE_API_KEY                                # optional; falls back to VATComply
```

## API Docs (local)

- Swagger: http://localhost:8000/api/docs
- ReDoc: http://localhost:8000/api/redoc
- OpenAPI JSON: http://localhost:8000/api/openapi.json

## Spec-Driven Development

This project uses **spec-first development**: a written specification is the single source of truth for every non-trivial feature. Code is written to satisfy the spec, not the other way around.

### When to write a spec

Write a spec before touching code when the work involves:
- A new workflow, pipeline stage, or background job
- Any change that touches more than 3 files
- Changes to the DB schema or data models
- Any external API integration or infrastructure change

Skip a spec for: bug fixes isolated to a single function, copy/label changes, trivial config tweaks.

### Spec document structure

Every spec lives in `specs/features/` and follows this structure:

```
specs/
  SPEC-TEMPLATE.md          ← the template (copy this)
  features/
    <feature-slug>.md       ← one spec per feature
```

A spec answers: *what are we building, for whom, and how do we know when it's done?* It must contain these sections (in order):

1. **Overview** — One paragraph: what is this feature and why does it exist? No jargon.
2. **User Stories** — `As a [user] I want [goal] so that [reason]`. One story per distinct outcome.
3. **Acceptance Criteria** — GIVEN / WHEN / THEN format. Each criterion must be binary pass/fail — no "should be fast", only "response < 2s under 100 concurrent users".
4. **Architecture Notes** — Mermaid diagram of the new flow, components involved, data flow, and constraints specific to this feature. Not the whole system — only what changes.
5. **Task Breakdown** — Ordered list of atomic, independently-committable steps. Each step names the files it touches and its own acceptance test.

> [!important] What does NOT belong in a spec
> Code style, build commands, library choices, agent boundaries, and project conventions **do not belong here**. Those are project-wide concerns that live in this CLAUDE.md. A spec is about *this feature only*.

### Agent permission boundaries (Three-Tier System)

| Tier          | What it means                   | Examples                                                       |
| ------------- | ------------------------------- | -------------------------------------------------------------- |
| **Always Do** | Safe, no approval needed        | Run tests, read files, format code, run linters                |
| **Ask First** | High-impact, needs human review | Change DB schema, add new dependencies, modify migrations      |
| **Never Do**  | Hard stops — do not proceed     | Commit secrets, delete prod data, push to main, skip test runs |

### Rules

- **Spec first, code second.** Never start implementing a feature without a written, reviewed spec.
- **Specs are immutable during implementation.** Changing scope mid-implementation requires updating the spec and getting re-alignment before continuing.
- **Acceptance criteria are verifiable.** Each must have a binary pass/fail result.
- **One spec per feature.** Do not bundle unrelated changes into a single spec.
- **Separate WHAT from HOW.** User stories and acceptance criteria say what. Architecture notes say how. Do not mix them.
