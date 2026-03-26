---
title: "Validation Pipeline Redesign — Per-Supplier Parallelism via Temporal Child Workflows"
date: 2026-03-16
tags:
  - feature-spec
  - validation
  - temporal
  - pipeline
  - performance
status: draft-v4.1
type: feature-spec
branch: redesign_validation_pipeline
author: Venkatesh Murugadas
---

# Spec: Validation Pipeline Redesign — Per-Supplier Parallelism via Temporal Child Workflows

| Field            | Value                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| Status           | **Draft v4.1**                                                        |
| Branch           | `redesign_validation_pipeline`                                        |
| Author           | Venkatesh Murugadas                                                   |
| Created          | 2026-03-16                                                            |
| Last updated     | 2026-03-17 (v4.1)                                                     |
| Related doc      | `context/validation-pipeline-current.md` (baseline as-built analysis) |
| Previous version | v3 — centralized VAT+IBAN then fan-out for name/address only          |

---

## Review Changelog

| Version | Change |
|---|---|
| v1 | Initial draft |
| v2 | Added cancel propagation, batch-size determinism, payload limits |
| v3 | Added enrichment stage, centralized VAT+IBAN design, history budget analysis |
| v4 | **Breaking redesign**: VAT+IBAN move into per-supplier pipeline inside child workflows. Each supplier runs VAT+IBAN (parallel) → name/address → persist atomically. Enrichment stage removed. Rate-limiting trade-off documented and deferred. |
| v4.1 | Clarified **cache vs published state** semantics. VAT/IBAN/name-address may write cache independently, but supplier-side tables are published only after the full enabled per-supplier pipeline succeeds. Supplier page and dashboard business KPIs must count only published suppliers and identifiers. |

---

## 1. Overview

The current validation pipeline processes suppliers as global batches: all VAT IDs validated first, then all IBANs, then all Name/Address validations. This has three problems: (1) it takes hours to process 3,000–4,000 suppliers because activities are not maximally utilised, (2) the Temporal workflow history limit (~51,200 events) makes processing beyond ~7,300 suppliers **physically impossible**, and (3) when a job fails mid-way there is no streaming persistence — no supplier records are written to the DB until the very end, so restarts begin from zero.

This spec defines a two-level Temporal workflow hierarchy where each supplier runs its full pipeline atomically: **VAT + IBAN in parallel → name/address → persist**. All suppliers run these pipelines concurrently. The parent workflow fans out one child workflow per batch; within each child every supplier runs its own pipeline concurrently via `asyncio.gather`. VAT/IBAN/name-address activities may write their **validation cache tables** independently, but the supplier's **published supplier state** is written to the main supplier-side tables only after the full enabled per-supplier pipeline succeeds.

**Expected outcome**: Each supplier's record is in the DB as soon as its full pipeline completes successfully (streaming publish). A supplier that only has partial validation results in cache remains invisible to the supplier page and is excluded from dashboard business KPIs until publish succeeds. On any failure, already-computed validation stages are reused via the cache tables, while only fully published suppliers appear in the main supplier-side UI. Under the current 60-activity-slot ceiling, 3K suppliers drops from ~5 hours to ~1.5 hours via better slot utilisation. Processing 100K suppliers becomes architecturally possible.

---

## 2. Goals & Non-Goals

### Goals

- [G1] Remove the Temporal workflow history ceiling as a hard scaling limit.
- [G2] Run each supplier's full pipeline atomically: VAT + IBAN (parallel) → name/address → persist.
- [G3] Persist supplier-side records to the DB **only after the full enabled per-supplier pipeline succeeds** (streaming publish), not all-at-end.
- [G4] On failure, retry, or same-file re-upload, reuse already-computed VAT/IBAN/name-address results from the validation cache tables whenever possible.
- [G5] All suppliers within a batch run their pipelines concurrently (maximum slot utilisation).
- [G6] Propagate job cancellation to all in-flight child workflows immediately.
- [G7] Zero regression on existing functionality: API surface, DB schema, all validators, and the duplicate detection pipeline are unchanged.
- [G8] Safe rollout: use the existing Temporal workflow type name (`SupplierValidationV2`) which is already deployed on this branch.
- [G9] Configuration-driven batch sizing (`batch_size` in workflow input, materialised once at API entry point) — replay-safe.
- [G10] The supplier page shows **only fully published suppliers**; partially validated suppliers remain cache-only and invisible there.
- [G11] Dashboard business KPIs (supplier totals, VAT totals, IBAN totals, validation coverage) count **only published supplier-side rows**, never cache-only partial suppliers.

### Non-Goals

- [NG1] Changing the duplicate detection algorithm (stays global and sequential, after all suppliers are done).
- [NG2] Changing the LLM duplicate classification stage.
- [NG3] Adding new validation types.
- [NG4] Adding new frontend screens or redesigning the supplier/dashboard UX. Existing pages may change the semantics of their counts to use published supplier state only.
- [NG5] Changing the DB schema or adding migrations.
- [NG6] Implementing Continue-as-New (not needed at current scale of 3K–4K; see section 8.4).
- [NG7] Fixing the VAT rate-limiter across concurrent supplier pipelines (deferred; see section 8.2).

---

## 3. User Stories

**US1 — Large organization: scale beyond current limits**
As an organization uploading a CSV with 100K+ suppliers,
I want the validation pipeline to process the full file without hitting Temporal's 51,200-event history ceiling,
so that large uploads reliably succeed and do not require manual intervention or restarts.

**US2 — Operations team: streaming visibility during a running job**
As an operations team member monitoring a running validation job,
I want supplier records to appear in the database as each supplier's full pipeline completes,
so that I can see partial results while the job is still running rather than waiting until all-at-end.

**US3 — Developer: fast recovery from failures**
As a developer or system recovering from a crashed or timed-out workflow,
I want already-completed validation stages to be reused from cache tables rather than re-run from scratch,
so that retried jobs skip redundant external API calls, reduce costs, and complete significantly faster.

**US4 — Business analyst: trustworthy dashboard KPIs**
As a business analyst reviewing the supplier dashboard,
I want all KPI totals (supplier count, VAT coverage, IBAN coverage) to reflect only fully published suppliers,
so that partially validated or in-progress suppliers never inflate or distort the business-visible numbers.

**US5 — Administrator: reliable job cancellation**
As an administrator cancelling an in-flight validation job,
I want all child workflows to stop processing promptly after I press cancel,
so that no new suppliers are published after cancellation is acknowledged and the system reaches a clean stop state.

---

## 4. Acceptance Criteria

Each criterion is independently verifiable.

**AC1 — Per-supplier pipeline ordering**
GIVEN a test job containing a supplier S in a child batch
WHEN the child batch workflow processes S
THEN the Temporal UI event history for that child shows `validate_vat_per_supplier` and `validate_iban_per_supplier` both completing before `validate_name_address` starts for S

**AC2 — VAT + IBAN parallelism**
GIVEN a test job containing a supplier S with both VAT IDs and IBANs
WHEN the child workflow schedules validation for S
THEN `validate_vat_per_supplier` and `validate_iban_per_supplier` appear in the Temporal UI with overlapping `scheduledTime` and `startTime` timestamps, confirming they were scheduled within the same workflow task

**AC3 — Cross-supplier parallelism**
GIVEN a child batch containing 10 suppliers
WHEN the child workflow begins execution
THEN all 10 supplier pipelines are scheduled within 1 second of the child workflow starting, confirmed by near-simultaneous scheduling timestamps in the Temporal UI

**AC4 — Publish only on full pipeline success**
GIVEN a CSV with 10 suppliers where one supplier is forced to fail at name/address after VAT and IBAN succeeded
WHEN the job completes
THEN `vat_validations`, `iban_validations`, or `name_address_validations` may contain rows for that supplier, AND `suppliers`, `supplier_vat_ids`, `supplier_ibans`, and `supplier_companies` do NOT contain that supplier

**AC5 — Streaming publish during execution**
GIVEN a CSV split across 2 batches (batch_size=10 for testing)
WHEN the `suppliers` table is queried while the job is still running
THEN at least one row appears before all suppliers have completed, and every row represents a supplier whose full enabled pipeline succeeded; no partial supplier is present in published tables

**AC6 — VAT/IBAN context passed to name/address**
GIVEN a supplier that has VAT IDs and IBANs in a job with all validations enabled
WHEN `validate_name_address_activity` is invoked for that supplier
THEN the activity input contains non-null `vat_validation_status` and `iban_validation_status` fields, verifiable in worker logs or the Temporal activity input payload

**AC7 — Same-file re-upload reuses cache**
GIVEN a job was run on a CSV where some suppliers published fully and others failed mid-pipeline
WHEN the same CSV is re-uploaded with `force_revalidate=False` as a new job
THEN a new workflow execution is created, unchanged suppliers show cache hits in logs for VAT/IBAN/name-address, and only suppliers whose full pipeline succeeds are published; no partial supplier appears in supplier-side tables

**AC8 — Dashboard and supplier-page visibility counts published rows only**
GIVEN a job that is in progress or has failed, leaving some suppliers in cache-only state
WHEN comparing supplier-page totals and dashboard KPI counts against actual rows in `suppliers`, `supplier_vat_ids`, and `supplier_ibans`
THEN all business-visible counts match the published supplier-side tables only; cache-only partial suppliers do not appear in any user-visible totals

**AC9 — Full job completes successfully end-to-end**
GIVEN a test CSV of 36 suppliers with all validations enabled
WHEN the job reaches `completed` status
THEN all fully validated suppliers appear in `suppliers`, duplicate groups are detected, and dashboard totals match the published supplier-side tables; no stage errors out and no totals diverge

**AC10 — Cancellation propagates to all child workflows**
GIVEN a running job with name/address activities actively executing
WHEN cancel is pressed in the UI within 30 seconds of starting
THEN all child batch workflows transition to `CANCELLED` in the Temporal UI within 60 seconds, and no additional suppliers are published after cancellation is acknowledged

**AC11 — validate_vat=False skips VAT activities**
GIVEN a job submitted with `validate_vat=False`
WHEN the child workflows execute
THEN no `validate_vat_per_supplier_activity` appears in any child workflow's Temporal event history, and publish still occurs for suppliers whose other enabled validations succeed

**AC12 — Backward compatibility: V1 activities remain registered**
GIVEN a V1 workflow (`SupplierValidation`) is submitted after deploying the updated worker
WHEN the V1 workflow executes
THEN it completes successfully because old activities `validate_vat_batch`, `validate_iban_batch`, and `prepare_enrichment` are still registered on the worker

---

## 5. Background & Context

### 5.1 Why the current pipeline is slow

The current `SupplierValidationWorkflow` processes 3,000 suppliers like this:

```
parse all (1 activity)
  → validate ALL VATs (1 activity)  ─┐
  → validate ALL IBANs (1 activity) ─┘  parallel with each other
  → detect duplicates (1 activity)
  → validate Name/Address: batches of 50, asyncio.as_completed per batch
  → persist everything (1 activity)
```

The Name/Address stage processes 50 suppliers at a time via `NAME_ADDRESS_BATCH_SIZE = 50`. With 2 min/supplier average and 20 activity slots per worker pod, the 50-at-a-time batch loop creates idle gaps between batches and underutilises the 20 available activity slots. 3,000 suppliers takes ~5 hours.

### 5.2 Why 100K suppliers crashes the workflow

Each Temporal activity generates **~7 history events**. Hard limit per workflow execution: **51,200 events**.

| Scenario | Events | Result |
|---|---|---|
| 3,000 Name/Address activities | ~21,000 | Works today, near warning (10,240) |
| 10,000 Name/Address activities | ~70,000 | **Crashes** |
| 100,000 Name/Address activities | ~700,000 | **Impossible** |

### 5.3 Why child workflows solve the history problem

Each child workflow has its own **isolated** 51,200-event budget. The parent workflow only records child start/completion events.

```
Parent (3K suppliers, batch_size=200, 15 children):
  15 child starts + 15 completions ≈ 90 events  ✓ (vs 21,000 today)

Each child (200 suppliers, per-supplier pipeline):
  200 × (VAT(3) + IBAN(3) + name_address(7) + persist(3)) ≈ 3,200 events  ✓
```

For 100K suppliers with batch_size=200: 500 children × 3 events/child = 1,500 events in parent. Each child: same ~3,200 events. Continue-as-New not required at this scale.

### 5.4 Why VAT + IBAN move into children (v4 change from v3)

**v3 rationale for keeping them centralised**: The VATValidator rate limiter is `threading.Semaphore(2)` per instance. If VAT is in children, N concurrent children × 1 VATValidator instance each = N×2 req/sec to VATSense — uncontrolled.

**v4 decision**: Move VAT + IBAN into per-supplier child pipelines. The rate-limiting issue is **deferred** (see section 8.2). The correctness and streaming-persistence goals outweigh the rate-limit risk at current scale (3K–4K suppliers). VATSense retries are configured on the retry policy and the existing cache means re-validation on retry is minimal. A shared rate-limiter across child workflows can be added in a future sprint if needed.

The key correctness benefit: each supplier's VAT + IBAN result is immediately available as context for its name/address validation, without the intermediate enrichment-file step. This eliminates an entire activity stage and simplifies the data flow.

### 5.5 How recovery and visibility work

This relies on two mechanisms:

1. **Temporal event history replay**: When the parent workflow restarts after a crash, it replays its event history. Any child workflow that previously completed returns its stored result from event history — the child is **not re-started**, and its activities are **not re-run**. This is automatic; no application code needed.

2. **DB validation cache**: Each individual activity checks its cache table before calling external APIs:
   - `vat_validations` table: checked by `validate_vat_per_supplier_activity`
   - `iban_validations` table: checked by `validate_iban_per_supplier_activity`
   - `name_address_validations` table: checked by `validate_name_address_activity`

   If a child workflow restarts (due to retry), already-validated suppliers' activities hit the cache and return immediately. Only `changed_supplier_ids` bypass the cache via `force_fresh=True`.

3. **Published supplier state**: `persist_single_supplier_activity` is the only writer of the main supplier-side tables (`suppliers`, `supplier_vat_ids`, `supplier_ibans`, `supplier_companies`). It runs only after all enabled validations for that supplier succeed. A supplier that has VAT/IBAN/name-address cache rows but has not yet passed the full pipeline is **not published** and must not appear in supplier-page data or dashboard business KPIs.

4. **New upload of the same CSV is a new workflow execution**: Re-uploading the same file does **not** reuse old Temporal event history because it gets a new `job_id` and a new workflow execution. It still benefits from the DB validation caches and from already-published supplier rows. So the recovery model is:
   - same workflow retry => Temporal history replay + validation cache reuse
   - new upload of same file => validation cache reuse + idempotent re-publish of already completed suppliers

5. **Visibility boundary**:
   - validation cache tables are internal recovery state and may contain partial suppliers
   - published supplier tables are the source of truth for the supplier page
   - dashboard business KPIs must be derived from published supplier tables only
   - job-progress widgets may separately show running / failed / completed supplier pipelines

### 5.6 Temporal Python SDK facts relevant to this design

| Fact | Source | Impact |
|---|---|---|
| `ChildWorkflowHandle` IS `asyncio.Task` (`_AsyncioTask`) | temporalio 1.23.0 source | Pass handles directly to `asyncio.wait()`. Never call `handle.result()` while pending — it calls `asyncio.Task.result()` (sync) and raises `InvalidStateError`. |
| Max concurrent pending child starts | Temporal docs | 2,000 per workflow task. With batch_size=200 and 100K suppliers: 500 children — safely within limit. |
| Max history events (hard error) | Temporal docs | 51,200. With per-supplier pipeline in children: ~3,200 events per child. Parent: ~150 events. Safe at any scale up to 100K. |
| `asyncio.gather` with child handles | Temporal samples (batch_sliding_window) | Officially supported. Pass handles or coroutines from `execute_child_workflow`. |
| Continue-as-New with running children | Temporal docs | Children are NOT carried over on CAN. Avoid CAN while children are running unless using `ABANDON` policy + signal tracking. Not needed at current scale. |
| Payload size limit | Temporal docs | 2 MB per activity result (hard), 256 KB recommended. Pass file paths for large data; inline supplier records (~2 KB each) are safe. |
| `asyncio.gather` inside child workflow | Official hello_parallel_activity sample | Correct pattern for parallel activities. Each `execute_activity()` call schedules concurrently. |

### 5.7 Deployment environment (unchanged from v3)

| Component | Replicas | CPU | Memory |
|---|---|---|---|
| Backend (gunicorn, 2 workers) | 1–3 (HPA at 40% CPU / 50% mem) | 1–4 cores | 2–8 Gi |
| **Temporal worker sidecar** | **1–3 (HPA)** | **0.5–2 cores** | **1–4 Gi** |

**Effective activity capacity**: 3 pods × 20 activities = **60 concurrent validations** (any type).

**Shared storage**: EFS `ReadWriteMany` at `/tmp`. `WORKFLOW_TEMP_DIR=/tmp` on all containers.

---

## 6. Architecture

### 6.1 New workflow topology

```
SupplierValidationV2  (parent workflow — 1 per upload job)
│
│  [Stage 1: Parse]
├── parse_data_activity  (UNCHANGED — writes per-batch manifest files)
│     Returns: batch_manifest_paths, total_suppliers, changed_suppliers
│
│  [Stage 2: Fan-out — all children start simultaneously]
├── SupplierBatchValidationWorkflow × N  (MODIFIED child workflow — 1 per batch)
│   │
│   │   For EACH supplier in batch, ALL running concurrently:
│   │
│   │  [Per-supplier Stage A: VAT + IBAN in parallel]
│   ├── validate_vat_per_supplier_activity   ─┐  (NEW — 1 supplier's VAT IDs only)
│   └── validate_iban_per_supplier_activity  ─┘  (NEW — 1 supplier's IBANs only)
│   │
│   │  [Per-supplier Stage B: Name/Address — uses VAT+IBAN status as context]
│   ├── validate_name_address_activity  (UNCHANGED, per-supplier)
│   │
│   │  [Per-supplier Stage C: Publish this supplier immediately on full success only]
│   └── persist_single_supplier_activity  (NEW — 1 supplier at a time)
│
│  [Stage 3: Global duplicate detection — after ALL children complete]
├── detect_duplicates_activity  (UNCHANGED)
│
│  [Stage 4: LLM duplicate classification — optional]
├── validate_duplicate_groups_llm_activity  (UNCHANGED)
│
│  [Stage 5: Persist duplicate groups + output CSV]
└── persist_duplicate_groups_activity  (UNCHANGED)
```

### 6.2 Per-supplier flow within each child (the core change)

```
Supplier A:  VAT_A ─┐                          ┐
             IBAN_A ─┘→ NameAddress_A → Persist_A│
                                                  │  all running
Supplier B:  VAT_B ─┐                          │  in parallel
             IBAN_B ─┘→ NameAddress_B → Persist_B│  within the
                                                  │  child workflow
Supplier C:  VAT_C ─┐                          │
             IBAN_C ─┘→ NameAddress_C → Persist_C│
              ...                               ┘
```

Each supplier's pipeline is independent. VAT and IBAN run in parallel for that supplier. Name/Address uses their results directly (no enrichment file). **Only when all enabled validations succeed** is that supplier published to DB. The next supplier's publish does not wait for other suppliers. A supplier whose VAT/IBAN/name-address partially completed but whose full pipeline failed remains cache-only and unpublished.

### 6.3 Removed stages (vs v3)

| Stage | v3 | v4 |
|---|---|---|
| Centralized VAT batch activity | ✅ in parent | ❌ removed |
| Centralized IBAN batch activity | ✅ in parent | ❌ removed |
| prepare_enrichment_activity | ✅ in parent | ❌ removed |
| enrichment.json file on EFS | ✅ written by enrichment stage | ❌ not needed |
| Per-supplier VAT activity in child | ❌ | ✅ NEW |
| Per-supplier IBAN activity in child | ❌ | ✅ NEW |
| Per-supplier persist activity in child | ❌ | ✅ NEW |

### 6.4 Data flow

```
CSV on EFS (/tmp/uploads/{job_id}/input.csv)
  │
  ▼
parse_data_activity (UNCHANGED)
  ├── writes: /tmp/hypatos-validate/{job_id}/batch_0000.json  (200 supplier records)
  ├── writes: /tmp/hypatos-validate/{job_id}/batch_0001.json
  ├── ...
  └── returns: batch_manifest_paths[], changed_suppliers[], total_suppliers
  │
  ▼  (fan-out — all children start simultaneously)
  ├── SupplierBatchValidationWorkflow [batch-0]
  │     reads: batch_0000.json (contains supplier_lookup records for 200 suppliers)
  │     for each supplier (all in parallel via asyncio.gather):
  │       → validate_vat_per_supplier_activity  (reads/writes vat_validations cache table)
  │       → validate_iban_per_supplier_activity (reads/writes iban_validations cache table)
  │       → validate_name_address_activity      (reads/writes name_address_validations cache table)
  │       → persist_single_supplier_activity    (writes published supplier state only if
  │                                               all enabled validations succeeded:
  │                                               suppliers, supplier_vat_ids,
  │                                               supplier_ibans, supplier_companies)
  │
  ├── SupplierBatchValidationWorkflow [batch-1]  ← simultaneous
  │     (same pipeline for next 200 suppliers)
  │
  └── ... up to N batches
  │
  ▼  (after all children complete)
detect_duplicates_activity  (reads from DB + CSV)
  ├── writes: /tmp/hypatos-validate/{job_id}/pairs.json
  └── writes: /tmp/hypatos-validate/{job_id}/groups.json
  │
  ▼  (optional)
validate_duplicate_groups_llm_activity
  └── writes: /tmp/hypatos-validate/{job_id}/groups_filtered.json
  │
  ▼
persist_duplicate_groups_activity  (reads DB + files, writes duplicate_groups tables)
  └── writes: output CSV
```

### 6.5 Cache state vs published state

| State | Tables | When written | Visible in supplier page? | Counted in dashboard business KPIs? |
|---|---|---|---|---|
| Validation cache state | `vat_validations`, `iban_validations`, `name_address_validations` | As each validation activity completes | ❌ No | ❌ No |
| Published supplier state | `suppliers`, `supplier_vat_ids`, `supplier_ibans`, `supplier_companies` | Only after full enabled per-supplier pipeline succeeds | ✅ Yes | ✅ Yes |

**Required semantics**:
- Partial suppliers are allowed in validation cache tables.
- Partial suppliers are **not** allowed in published supplier-side tables.
- The supplier page must query published tables only.
- Dashboard KPI cards and aggregates must query published tables only.
- Job-progress displays may separately show `total`, `published`, `failed`, and `running` supplier pipelines.

### 6.6 Progress mapping

| Range | Stage |
|---|---|
| 0–10% | Parse + batch manifest creation |
| 10–80% | Child batch workflows (per-supplier VAT+IBAN+name_address+publish, fan-out) |
| 80–85% | Duplicate detection |
| 85–90% | LLM duplicate validation (optional) |
| 90–95% | Persist duplicate groups + output CSV |
| 95–100% | Finalize |

---

## 7. Detailed Design

### 7.1 Modified: `src/workflows/validation_workflow_v2.py`

**Remove from parent workflow**:
- `_run_vat_iban_stage()` method (entire method deleted)
- `prepare_enrichment` activity call
- All references to `_vat_result`, `_iban_result`, `_enrichment_result` instance variables
- `WorkflowStatus.VALIDATING_VAT`, `VALIDATING_IBAN`, `PREPARING_ENRICHMENT` stage updates

**Simplified parent `run()` flow**:

```python
@workflow.run
async def run(self, input: ValidationWorkflowInputV2) -> ValidationWorkflowResult:
    # Stage 1: Parse
    self._parse_result = await self._execute_activity_with_shutdown_retry(
        "parse_data", ParseDataInput(...), ...
    )

    # Stage 2: Fan-out (children handle per-supplier VAT+IBAN+N/A+publish)
    await self._execute_activity_with_shutdown_retry(
        "update_job_status",
        UpdateJobStatusInput(status="running", progress=10, current_step="Validating suppliers"),
        ...
    )
    await self._run_supplier_batches(input)

    # Stages 3–5: Duplicate detection (unchanged)
    await self._run_duplicate_stages(input)
```

**`_run_supplier_batches` — no change to fan-out logic**:

```python
async def _run_supplier_batches(self, input: ValidationWorkflowInputV2) -> None:
    batch_manifest_paths = self._parse_result.get("batch_manifest_paths", [])
    changed_suppliers = set(self._parse_result.get("changed_suppliers", []))

    child_handles = []
    self._child_handles = child_handles

    for batch_index, manifest_path in enumerate(batch_manifest_paths):
        batch_supplier_ids = _read_batch_supplier_ids(manifest_path)
        batch_changed = [s for s in batch_supplier_ids if s in changed_suppliers]

        handle = await workflow.start_child_workflow(
            SupplierBatchValidationWorkflow.run,
            SupplierBatchWorkflowInput(
                job_id=input.job_id,
                organization_id=input.organization_id,
                batch_manifest_path=manifest_path,
                csv_file_path=input.input_file_path,
                batch_index=batch_index,
                changed_supplier_ids=batch_changed,
                validate_vat=input.validate_vat,
                validate_iban=input.validate_iban,
                validate_name_address=input.validate_name_address,
                force_revalidate=input.force_revalidate,
                search_tool=input.search_tool,
                name_address_custom_instruction=input.name_address_custom_instruction,
            ),
            id=f"{input.job_id}-batch-{batch_index}",
            parent_close_policy=ParentClosePolicy.TERMINATE,
        )
        child_handles.append(handle)

    await self._wait_for_batch_results(child_handles)
```

Note: `enrichment_file_path` field is removed from `SupplierBatchWorkflowInput`. The child no longer needs it; VAT/IBAN results are passed directly between activities within the child.

**`_wait_for_batch_results` — already fixed in current code** (uses `asyncio.wait` with handles directly).

---

### 7.2 Modified: `src/workflows/supplier_batch_workflow.py`

This is the most significant change. The child workflow now runs a **per-supplier pipeline** using `asyncio.gather`.

```python
@workflow.defn(name="SupplierBatchValidation")
class SupplierBatchValidationWorkflow:

    @workflow.run
    async def run(self, input: SupplierBatchWorkflowInput) -> SupplierBatchWorkflowResult:
        with workflow.unsafe.imports_passed_through():
            suppliers = _load_json_records(input.batch_manifest_path)

        suppliers = [s for s in suppliers if s.get("external_id") or s.get("supplier_external_id")]

        # Run every supplier's pipeline concurrently.
        # asyncio.gather is the officially-supported Temporal pattern for
        # concurrent activities (see hello_parallel_activity sample).
        # return_exceptions=True so one supplier failure doesn't abort others.
        tasks = [
            asyncio.create_task(self._run_supplier_pipeline(supplier, input))
            for supplier in suppliers
        ]

        try:
            results = await asyncio.gather(*tasks, return_exceptions=True)
        except asyncio.CancelledError:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise

        succeeded = sum(
            1
            for r in results
            if not isinstance(r, Exception) and r.get("success", False)
        )
        failed = len(results) - succeeded

        if failed:
            logger.warning(
                "Job %s batch %d: %d/%d supplier pipelines failed",
                input.job_id, input.batch_index, failed, len(results),
            )

        return SupplierBatchWorkflowResult(
            success=True,
            batch_index=input.batch_index,
            suppliers_processed=succeeded,
            suppliers_failed=failed,
        )

    async def _run_supplier_pipeline(
        self,
        supplier: dict,
        input: SupplierBatchWorkflowInput,
    ) -> dict:
        """
        Full per-supplier pipeline:
          1. VAT + IBAN in parallel  (writes to validation cache tables)
          2. Name/Address            (uses VAT+IBAN status as context)
          3. Publish                 (writes supplier-side tables to DB immediately on full success)
        """
        supplier_id = str(
            supplier.get("external_id") or supplier.get("supplier_external_id", "")
        )
        changed_set = set(input.changed_supplier_ids)
        force_fresh = input.force_revalidate or supplier_id in changed_set

        # ── Stage A: VAT + IBAN in parallel 
        vat_result, iban_result = await asyncio.gather(
            workflow.execute_activity(
                "validate_vat_per_supplier",
                VATPerSupplierInput(
                    job_id=input.job_id,
                    organization_id=input.organization_id,
                    supplier_id=supplier_id,
                    supplier_data_json=json.dumps(supplier),
                    force_fresh=force_fresh,
                    enabled=input.validate_vat,
                ),
                start_to_close_timeout=timedelta(minutes=10),
                retry_policy=SLOW_RETRY_POLICY,
            ),
            workflow.execute_activity(
                "validate_iban_per_supplier",
                IBANPerSupplierInput(
                    job_id=input.job_id,
                    organization_id=input.organization_id,
                    supplier_id=supplier_id,
                    supplier_data_json=json.dumps(supplier),
                    force_fresh=force_fresh,
                    enabled=input.validate_iban,
                ),
                start_to_close_timeout=timedelta(minutes=2),
                retry_policy=FAST_RETRY_POLICY,
            ),
        )

        # ── Stage B: Name/Address (conditional) ──────────────────────────────
        name_result = None
        if input.validate_name_address:
            name_result = await workflow.execute_activity(
                "validate_name_address",
                NameAddressValidationInput(
                    job_id=input.job_id,
                    organization_id=input.organization_id,
                    supplier_id=supplier_id,
                    supplier_data_json=json.dumps(supplier),
                    vat_validation_status=vat_result.get("overall_status") if vat_result else None,
                    iban_validation_status=iban_result.get("overall_status") if iban_result else None,
                    search_tool=input.search_tool,
                    custom_instruction=input.name_address_custom_instruction,
                    force_fresh=force_fresh,
                ),
                start_to_close_timeout=timedelta(minutes=15),
                heartbeat_timeout=timedelta(minutes=5),
                retry_policy=LLM_RETRY_POLICY,
            )

        # ── Publish gate: all enabled validations must have succeeded ─────────
        stage_results = []
        if input.validate_vat and supplier.get("vat_ids"):
            stage_results.append(vat_result)
        if input.validate_iban and supplier.get("ibans"):
            stage_results.append(iban_result)
        if input.validate_name_address:
            stage_results.append(name_result)

        if any((not r) or (not r.get("success", False)) for r in stage_results):
            return {
                "supplier_id": supplier_id,
                "success": False,
                "published": False,
            }

        # ── Stage C: Publish this supplier atomically ─────────────────────────
        persist_result = await workflow.execute_activity(
            "persist_single_supplier",
            PersistSingleSupplierInput(
                job_id=input.job_id,
                organization_id=input.organization_id,
                supplier_data=supplier,
                csv_file_path=input.csv_file_path,
            ),
            start_to_close_timeout=timedelta(minutes=10),
            retry_policy=SLOW_RETRY_POLICY,
        )

        return {
            "supplier_id": supplier_id,
            "success": persist_result.get("success", False),
            "published": persist_result.get("success", False),
        }
```

**Failure semantics**:
- Cache activities may succeed and write their cache tables even if a later stage in the supplier pipeline fails.
- `persist_single_supplier_activity` MUST NOT run unless every enabled validation stage returned `success=True`.
- Per-supplier pipeline failure is **soft** (logged, counted, does not abort the batch), but the supplier remains **unpublished**.
- The child workflow always returns `success=True` with `suppliers_failed` count and `suppliers_published` (or equivalent) count.
- The parent treats child workflow failure (e.g., from a bug or timeout exhaustion) as a **hard failure** and fails the job.

---

### 7.3 New: `src/workflows/activities/vat_per_supplier_activity.py`

Validates VAT IDs for a **single supplier** using the existing `VATValidator`.

```python
@dataclass
class VATPerSupplierInput:
    job_id: str
    organization_id: int
    supplier_id: str
    supplier_data_json: str  # Full supplier record (name, vat_ids list, etc.)
    force_fresh: bool = False
    enabled: bool = True     # If False (validate_vat=False), skip and return skipped result


@dataclass
class VATPerSupplierResult:
    success: bool
    supplier_id: str
    overall_status: str = "skipped"  # "valid", "invalid", "mixed", "skipped", "error"
    validated_count: int = 0
    valid_count: int = 0
    error: Optional[str] = None


@activity.defn(name="validate_vat_per_supplier")
async def validate_vat_per_supplier_activity(
    input: VATPerSupplierInput,
) -> VATPerSupplierResult:
    activity.heartbeat(f"VAT validation for {input.supplier_id}")

    if not input.enabled:
        return VATPerSupplierResult(success=True, supplier_id=input.supplier_id, overall_status="skipped")

    supplier = json.loads(input.supplier_data_json)
    # Extract VAT IDs for this supplier from supplier_data
    # supplier_data comes from supplier_lookup which has vat_ids as a list
    vat_ids = _extract_vat_ids(supplier)

    if not vat_ids:
        return VATPerSupplierResult(success=True, supplier_id=input.supplier_id, overall_status="skipped")

    validator = VATValidator(
        session_factory=get_session_factory(),
        organization_id=input.organization_id,
        force_fresh=input.force_fresh,
    )

    results = await validator.validate_vat_ids(
        vat_ids=vat_ids,
        supplier_id=input.supplier_id,
    )

    valid_count = sum(1 for r in results if r.get("is_valid"))
    overall = "valid" if valid_count == len(results) else ("mixed" if valid_count > 0 else "invalid")

    return VATPerSupplierResult(
        success=True,
        supplier_id=input.supplier_id,
        overall_status=overall,
        validated_count=len(results),
        valid_count=valid_count,
    )
```

**`_extract_vat_ids`**: Parses the supplier_data dict to extract VAT ID strings. The supplier_lookup record from `parse_data_activity` includes a `vat_id` field (or list). Implementation reads `supplier.get("vat_id")` and handles string/list variants matching DuplicateDetector's output format.

---

### 7.4 New: `src/workflows/activities/iban_per_supplier_activity.py`

Validates IBANs for a **single supplier** using the existing `IBANValidator`.

```python
@dataclass
class IBANPerSupplierInput:
    job_id: str
    organization_id: int
    supplier_id: str
    supplier_data_json: str
    force_fresh: bool = False
    enabled: bool = True


@dataclass
class IBANPerSupplierResult:
    success: bool
    supplier_id: str
    overall_status: str = "skipped"  # "valid", "invalid", "mixed", "skipped"
    validated_count: int = 0
    valid_count: int = 0
    error: Optional[str] = None


@activity.defn(name="validate_iban_per_supplier")
async def validate_iban_per_supplier_activity(
    input: IBANPerSupplierInput,
) -> IBANPerSupplierResult:
    activity.heartbeat(f"IBAN validation for {input.supplier_id}")

    if not input.enabled:
        return IBANPerSupplierResult(success=True, supplier_id=input.supplier_id, overall_status="skipped")

    supplier = json.loads(input.supplier_data_json)
    ibans = _extract_ibans(supplier)

    if not ibans:
        return IBANPerSupplierResult(success=True, supplier_id=input.supplier_id, overall_status="skipped")

    validator = IBANValidator(
        session_factory=get_session_factory(),
        organization_id=input.organization_id,
        force_fresh=input.force_fresh,
    )

    results = await validator.validate_ibans(
        ibans=ibans,
        supplier_id=input.supplier_id,
    )

    valid_count = sum(1 for r in results if r.get("is_valid"))
    overall = "valid" if valid_count == len(results) else ("mixed" if valid_count > 0 else "invalid")

    return IBANPerSupplierResult(
        success=True,
        supplier_id=input.supplier_id,
        overall_status=overall,
        validated_count=len(results),
        valid_count=valid_count,
    )
```

**Note on IBAN validation speed**: IBAN validation is local-only (Schwifty library, <1ms/IBAN) with cache. This activity completes in milliseconds and always wins the `asyncio.gather` with VAT. VAT result will be available when name/address starts.

---

### 7.5 New: `src/workflows/activities/persist_single_supplier_activity.py`

Persists one supplier's records to the DB **without loading the full CSV**. Uses inline supplier data from the batch manifest.

```python
@dataclass
class PersistSingleSupplierInput:
    job_id: str
    organization_id: int
    supplier_data: dict          # Full supplier_lookup record from parse_data
    csv_file_path: str           # Retained for future use; not read in this activity

@dataclass
class PersistSingleSupplierResult:
    success: bool
    supplier_id: str = ""
    created: bool = False        # True if new supplier row, False if updated
    error: Optional[str] = None

@activity.defn(name="persist_single_supplier")
async def persist_single_supplier_activity(
    input: PersistSingleSupplierInput,
) -> PersistSingleSupplierResult:
    activity.heartbeat(f"Persisting supplier {input.supplier_data.get('external_id', '')}")

    try:
        supplier = input.supplier_data
        supplier_id = str(supplier.get("external_id") or supplier.get("supplier_external_id", ""))
        # Build minimal DataFrames from the supplier_lookup record.
        # The supplier_lookup dict mirrors the columns of DuplicateDetector's DataFrames,
        # so we can construct single-row DataFrames for the persister.
        suppliers_df = _build_suppliers_df(supplier)
        vat_ids_df = _build_vat_ids_df(supplier)
        bank_accounts_df = _build_bank_accounts_df(supplier)
        companies_df = _build_companies_df(supplier)
        stats = {"suppliers_created": 0, "suppliers_updated": 0, ...}
        async with get_session_factory()() as session:
            persister = ValidationResultsPersister(session, input.organization_id)
            await persister._persist_suppliers(suppliers_df, stats)
            if not vat_ids_df.empty:
                await persister._persist_vat_ids(vat_ids_df, stats)
            if not bank_accounts_df.empty:
                await persister._persist_ibans(bank_accounts_df, stats)
            if not companies_df.empty:
                await persister._persist_companies(companies_df, stats)
            await session.commit()
        return PersistSingleSupplierResult(
            success=True,
            supplier_id=supplier_id,
            created=stats.get("suppliers_created", 0) > 0,
        )
    except Exception as e:
        logger.exception("Failed to persist supplier %s: %s", supplier_id, e)
        return PersistSingleSupplierResult(success=False, supplier_id=supplier_id, error=str(e))
```

**`_build_suppliers_df`, `_build_vat_ids_df`, `_build_bank_accounts_df`, `_build_companies_df`**: Module-level helpers that build single-row (or multi-row for IDs/IBANs/companies) pandas DataFrames from the supplier_lookup dict. The column names match those produced by `DuplicateDetector` so the existing `ValidationResultsPersister` methods work without modification.

**Key point**: This activity does NOT load the CSV via DuplicateDetector. It uses only the inline supplier_data dict. This makes persistence O(1) per supplier regardless of total dataset size.

**Publish semantics**:
- This activity is the **only** writer of published supplier-side state.
- It must write `suppliers`, `supplier_vat_ids`, `supplier_ibans`, and `supplier_companies` in one transaction.
- It is called only after all enabled validations for that supplier succeeded.
- If it is never called, the supplier is not visible in the supplier page and its VAT/IBAN counts must not contribute to dashboard business KPIs.

---

### 7.6 Modified: `src/workflows/models.py`

**Add**:
```python
@dataclass
class VATPerSupplierInput:      # see section 7.3
class VATPerSupplierResult:     # see section 7.3
class IBANPerSupplierInput:     # see section 7.4
class IBANPerSupplierResult:    # see section 7.4
class PersistSingleSupplierInput:  # see section 7.5
class PersistSingleSupplierResult: # see section 7.5
```

**Modify `SupplierBatchWorkflowInput`**:
- Remove `enrichment_file_path: str` field
- Add `validate_vat: bool = True` field
- Add `validate_iban: bool = True` field

**Modify `SupplierBatchWorkflowResult`**:
- `suppliers_processed` must mean **fully published suppliers**, not merely attempted suppliers
- Keep `suppliers_failed` for unpublished suppliers whose pipeline did not fully complete

**Modify `ParseDataResult`**:
- Remove the unused `supplier_ids` field from the V2 path to avoid unnecessary Temporal payload growth

**Keep unchanged**: `VATValidationInput`, `IBANValidationInput` (used by batch validators elsewhere), all duplicate-detection models, `NameAddressValidationInput`, `PersistSupplierBatchInput`.

---

### 7.7 Modified: `src/workflows/worker.py`

Register new activities:

```python
activities=[
    # Existing
    parse_data_activity,
    validate_name_address_activity,
    persist_supplier_batch_activity,
    persist_duplicate_groups_activity,
    detect_duplicates_activity,
    validate_duplicate_groups_llm_activity,
    prepare_enrichment_activity,   # Keep for any in-flight v3 workflows
    validate_vat_batch_activity,   # Keep for any in-flight v3 workflows
    validate_iban_batch_activity,  # Keep for any in-flight v3 workflows
    update_job_status_activity,
    # New
    validate_vat_per_supplier_activity,
    validate_iban_per_supplier_activity,
    persist_single_supplier_activity,
]
```

---

### 7.8 Unchanged files

- `src/workflows/activities/duplicate_activity.py`
- `src/workflows/activities/llm_duplicate_activity.py`
- `src/workflows/activities/name_address_activity.py`
- `src/workflows/activities/persist_batch_activity.py` (kept for backward compat)
- `src/workflows/activities/vat_activity.py` (kept for backward compat)
- `src/workflows/activities/iban_activity.py` (kept for backward compat)
- `src/validators/` — all validator classes unchanged
- `src/db/models.py` — DB schema unchanged
- `src/api/routes/suppliers.py` — can remain functionally unchanged because it already reads published supplier tables

### 7.9 Modified: dashboard aggregation semantics

`src/api/routes/dashboard.py` and any repository helpers it uses must be updated so that:
- supplier totals come from `suppliers`
- VAT totals come from `supplier_vat_ids` joined to published suppliers
- IBAN totals come from `supplier_ibans` joined to published suppliers
- approval / review / risk counts come from `suppliers` + published `name_address_validations`
- cache-only rows in `vat_validations`, `iban_validations`, and `name_address_validations` are not counted in the main dashboard KPI cards

It is acceptable to expose cache statistics separately for operational monitoring, but they must not be mixed into business-visible totals.

---

## 8. Deployment & Configuration

### 8.1 No new environment variables

`SUPPLIER_BATCH_SIZE` (default 200) already exists and is materialised at API entry.

### 8.2 Rollout

The workflow type name `SupplierValidationV2` is unchanged. Old v3 in-flight workflows (if any) use the old activity names (`validate_vat_batch`, `validate_iban_batch`, `prepare_enrichment`) which remain registered. New workflows use the new per-supplier activity names. No mixed-version nondeterminism risk.

### 8.3 No infrastructure changes

Same EFS mount, same Temporal namespace, same DB schema.

---

## 9. Constraints & Trade-offs

### 9.1 Hard constraints

| Constraint | Value | Source |
|---|---|---|
| Temporal history events per workflow | 51,200 hard / 10,240 soft | Temporal docs |
| Max concurrent pending child starts | 2,000 per workflow task | Temporal docs |
| Activity payload size | 2 MB hard | Temporal docs |
| Supplier record size | ~2–5 KB | Empirical |
| Worker activity slots | 60 (3 pods × 20) | ArgoCD values |
| PostgreSQL connections | 100 max, 78 in use | Section 5.7 |

### 9.2 Known trade-off: VAT rate limiting (deferred)

`VATValidator` uses `threading.Semaphore(2)` per instance. Each `validate_vat_per_supplier_activity` creates a new instance. With 200 concurrent suppliers per batch and N batches running simultaneously, this creates N×200 VATValidator instances each with their own 2 req/sec semaphore — effectively unlimited QPS to VATSense.

**Accepted risk**: At 3K–4K suppliers, VATSense rate limit errors will trigger Temporal's retry policy (3 attempts, backoff). The DB cache means re-validation on retry is minimal (only failed IDs retry). This is acceptable for the current scale.

**Future fix** (not in scope): Add a shared `asyncio.Semaphore` in the worker process that all per-supplier VAT activities share, enforcing a global rate limit regardless of concurrency.

### 9.3 DB connection budget with per-supplier persistence

With 200 concurrent `persist_single_supplier_activity` calls per child batch:
- Each activity opens and closes one async DB session (existing pattern)
- SQLAlchemy async pool: min=1, max=5 per process (default)
- 200 concurrent persist calls across 60 activity slots = at most 60 concurrent sessions
- 3 worker pods × 20 connections = 60 additional connections in use during peak persist
- Total with existing: 78 + 60 = 138 — **exceeds the 100-connection limit**

**Mitigation**: Reduce `max_concurrent_activities` from 20 to 10 on the worker, or increase PostgreSQL `max_connections` to 200 in the deployment config. The ArgoCD values.yaml already sets `max_connections` as a Temporal config (confirm actual Postgres config). This must be tuned during testing.

Alternatively, the persist activity uses a short-lived session (single transaction), so connection hold time is <100ms, and SQLAlchemy pool cycling means peak concurrent connections will be lower than the ceiling calculation above.

### 9.4 Continue-as-New (not needed at current scale)

Per the research:
- Parent history with 3K suppliers, batch_size=200: 15 children × 3 events = 45 events + overhead ≈ 150 events. Far below 51,200.
- Per child (200 suppliers × 4 activities × avg 4 events): ~3,200 events. Far below 51,200.
- At 100K suppliers: 500 children × 3 events = 1,500 events in parent. Still safe.

Continue-as-New is **not required** at any realistic scale for this use case. Temporal's CAN cannot carry over running children, making it complex to implement correctly. Defer indefinitely.

### 9.5 Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Keep VAT+IBAN centralised (v3) | Does not satisfy G2 (per-supplier atomic pipeline) or G3 (streaming persistence). Enrichment file adds complexity and a failure point. |
| One child workflow per supplier (not per batch) | 3K child handles in parent = ~9K events (safe), but 3K child workflow IDs to manage, higher Temporal overhead, 2K concurrent child start limit would require batching anyway. Batch-child approach gives same per-supplier parallelism with less overhead. |
| Per-supplier persist via CSV reload | Loading the full CSV once per supplier = O(N²) file I/O. Eliminated by passing inline supplier_data from batch manifest. |
| Shared rate-limiter for VAT | Correct long-term solution but adds distributed state complexity. Deferred to future sprint (section 9.2). |

---

## 10. Implementation Order

Each step is independently committable and testable.

1. **Tighten workflow/result models** in `src/workflows/models.py`.
   - Remove the unused `supplier_ids` from `ParseDataResult` for V2.
   - Define child-result fields so the parent tracks **published suppliers**, not merely attempted suppliers.
   - Keep backward-compatible fields where needed so unrelated workflow consumers do not break.

2. **Make batch manifests publish-complete** in `src/workflows/activities/parse_activity.py`.
   - Ensure the manifest carries everything needed to publish all supplier-side tables from inline data, including company IDs and IBAN metadata if required.
   - Do not reintroduce large Temporal payloads; keep bulky data in manifest files, not activity results.

3. **Keep per-stage validation activities cache-oriented**.
   - `validate_vat_per_supplier_activity`, `validate_iban_per_supplier_activity`, and `validate_name_address_activity` continue to own their cache tables.
   - Normalize supplier-level status semantics (`valid` / `invalid` / `mixed` / `skipped`) so the publish gate has accurate inputs.
   - Ensure retryable failures are surfaced correctly and ordinary failures return explicit `success=False`.

4. **Implement a strict publish gate** in `src/workflows/supplier_batch_workflow.py`.
   - Run VAT + IBAN in parallel, then name/address.
   - Before calling `persist_single_supplier`, check every enabled validation result.
   - If any enabled validation failed, mark the supplier pipeline failed and unpublished.
   - Report published and failed supplier counts accurately to the parent.

5. **Make `persist_single_supplier_activity` the sole publisher** in `src/workflows/activities/persist_single_supplier_activity.py`.
   - Write `suppliers`, `supplier_vat_ids`, `supplier_ibans`, and `supplier_companies` in one transaction.
   - Preserve the old persistence fidelity: no loss of company IDs, no loss of IBAN metadata.
   - Keep the activity idempotent so re-uploads and retries are safe.

6. **Update parent progress accounting** in `src/workflows/validation_workflow_v2.py`.
   - Progress must advance based on fully published suppliers, not on raw scheduled suppliers.
   - Job status payloads should make it possible to distinguish `published`, `failed`, and total suppliers without exposing partial supplier state in the main business UI.

7. **Update dashboard aggregation semantics** in `src/api/routes/dashboard.py` and supporting repository methods.
   - Main KPI cards must derive totals from published supplier-side tables only.
   - Cache-table stats may remain available as operational metrics, but must be isolated from business totals.
   - Do not change supplier-page query semantics if existing `suppliers`-based logic already satisfies the visibility rule.

8. **Keep rollout safe** in `src/workflows/worker.py` and routing code.
   - Preserve V1 workflow/activity registrations for in-flight jobs.
   - Do not change unrelated API contracts unless required for accurate published/failed progress reporting.

9. **Add focused tests and manual verification**.
   - Unit tests for publish gating and per-supplier status aggregation.
   - Integration test for `persist_single_supplier_activity` writing all supplier-side tables.
   - End-to-end test for partial failure: cache rows exist, supplier rows do not.
   - End-to-end test for same-file re-upload with `force_revalidate=False`: cache hits occur, published totals stay correct.
   - Dashboard verification: KPI totals match published supplier-side tables, not cache-only rows.

10. **Performance / cancellation validation**.
    - Submit a 500-supplier CSV. Measure time-to-first-published-supplier and time-to-all-suppliers-complete.
    - Verify DB connection count stays below 100 during peak publish.
    - Verify cancellation stops further publishes promptly and leaves unpublished suppliers cache-only.

---

## 11. Out of Scope

- Per-supplier Continue-as-New (not needed; see section 9.4)
- Shared VAT rate limiter across concurrent supplier pipelines (deferred; see section 9.2)
- DB connection pool tuning (may need `max_connections` increase; noted in section 9.3)
- Frontend changes to show per-supplier progress (future enhancement)
- Adding validation for additional field types
- Changing the output CSV format
- Multi-tenant isolation beyond `organization_id` scoping (already implemented)

---

## 12. Glossary

| Term | Definition |
|---|---|
| Batch manifest | A JSON file on EFS containing the `supplier_lookup` records for one batch of up to `batch_size` suppliers. Written by `parse_data_activity`. |
| Child workflow | A `SupplierBatchValidationWorkflow` instance handling one batch of suppliers. Started by the parent via `workflow.start_child_workflow`. |
| Enrichment | **Removed in v4.** In v3, this was a JSON file mapping supplier_id → {vat_status, iban_status}, written after centralized VAT+IBAN and read by child workflows before name/address. No longer needed since VAT+IBAN results are now passed inline between activities. |
| `force_fresh` | Per-supplier flag: if True, the activity bypasses the validation cache and re-validates against the external API. Set to True for `changed_suppliers` (suppliers whose master data differs from the last processed version). |
| Per-supplier pipeline | The atomic sequence for one supplier: VAT+IBAN (parallel) → name/address → persist. |
| Published supplier state | The business-visible supplier-side tables: `suppliers`, `supplier_vat_ids`, `supplier_ibans`, `supplier_companies`. A supplier enters this state only after the full enabled per-supplier pipeline succeeds. |
| `supplier_lookup` | A dict keyed by `supplier_external_id` mapping to the full supplier record (name, address, VAT IDs, IBANs, companies). Built by `DuplicateDetector.load_and_parse_data`. Written into batch manifests by `parse_data_activity`. |
| Streaming persistence | Persisting/publishing supplier records to the DB as each supplier's full pipeline completes, rather than all-at-end after the full batch finishes. Achieved by `persist_single_supplier_activity` called per-supplier within the child workflow. |
| Validation cache state | Internal recovery state stored in `vat_validations`, `iban_validations`, and `name_address_validations`. These rows may exist for partially processed suppliers and must not drive supplier-page or dashboard business totals. |
