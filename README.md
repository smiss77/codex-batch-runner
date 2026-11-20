# Generic Codex Two-Stage Batch Pipeline

A small, domain-neutral runner for executing many independent Codex CLI tasks with a controlled two-stage flow:

```text
stage 1: identify/extract  ──┐
                             ├─ fresh Codex session → final output
stage 2: independent review ┘
```

The runner does not know whether a task is document extraction, code generation, data labeling, research, or anything else. Domain behavior lives in your prompts and optional validator command.

## What it provides

- JSONL manifest with one independent task per row.
- Separate workspace and Codex process for every stage.
- Independent review session after stage 1.
- Read-only source copies in both stages.
- Read-only candidate handoff to stage 2, with SHA-256 integrity checks.
- Independent identify/review semaphores; default 5 + 5 sessions.
- Retries with preserved stage evidence, resume, task selection, dry-run, and status files.
- Optional command-based validator.
- Optional final-status file, so `verified` can be distinguished from domain-level `complete` or `partial`.

## Requirements

- Node.js 18+.
- Codex CLI available as `codex`, or set `codex.binary` in `config.json` / `CODEX_BIN` in your environment.
- A logged-in Codex CLI session and a model available to that account.

## Quick start

1. Copy the repository and install no packages; it has no npm dependencies.
2. Put source files somewhere outside `runs/`.
3. Create a manifest:

```jsonl
{"id":"doc-001","inputs":[{"path":"../inputs/doc-001.pdf","role":"source"}],"metadata":{"language":"zh"},"notes":"Extract the requested fields."}
{"id":"doc-002","inputs":[{"path":"../inputs/doc-002.pdf","role":"source"}]}
```

Paths are resolved relative to the manifest file. A task can have multiple inputs:

```json
{"id":"case-001","inputs":[{"path":"a.txt","role":"source"},{"path":"schema.json","role":"reference"}]}
```

3. Customize `prompts/identify.md` and `prompts/review.md`. These are intentionally generic placeholders.
4. Configure artifacts and validation in `config.json`.
5. Check preparation without invoking Codex:

```powershell
node pipeline/pipeline.js prepare --manifest examples/manifest.jsonl --run-id demo
```

6. Run the batch:

```powershell
node pipeline/pipeline.js run --manifest examples/manifest.jsonl --run-id demo
```

Useful options:

```text
--identify-concurrency N    stage 1 concurrency
--review-concurrency N      stage 2 concurrency
--concurrency N             set both
--only a,b                  run selected task IDs
--limit N / --offset N      select a slice
--dry-run                   prepare and inspect without Codex
--resume RUN_ID             continue the task IDs recorded in that run
--retry-completed           rerun completed stages
--identify-only             stop after stage 1
--review-only               use existing stage 1 output
--verify-only               run the configured validator
--skip-validation           do not run validation
--model MODEL               override config model
--effort LEVEL              override reasoning effort
--sandbox MODE              override Codex sandbox
```

Inspect results:

```powershell
node pipeline/pipeline.js status --run demo
node pipeline/pipeline.js summary --run demo
node pipeline/pipeline.js verify --run demo
```

## Configuration

`config.json` is the domain boundary:

- `stages.*.prompt`: prompt template path.
- `stages.*.requiredArtifacts`: files relative to that stage workspace. Use `output/` only if a domain has variable artifacts; prefer explicit paths for strict delivery.
- `candidate.target`: directory copied from stage 1 `output/` to stage 2.
- `validation.command`: argv array, for example `["node", "validator.js", "{{WORKSPACE}}"]`. It runs with the review workspace as cwd and must exit 0 on success.
- `finalStatus`: optional JSON file under the review workspace. Its field is surfaced as `review_final_status` and `delivery_status`.
- `codex.extraArgs`: extra arguments passed to every Codex invocation.

Prompt placeholders:

```text
{{TASK_ID}} {{STAGE}} {{WORKSPACE}}
{{INPUT_DIR}} {{INPUT_MANIFEST}} {{OUTPUT_DIR}}
{{CANDIDATE_DIR}} {{METADATA_JSON}} {{NOTES}}
```

## Workspace layout

```text
runs/<run-id>/
  manifest.jsonl
  run.json
  summary.json
  tasks/<task-id>/
    status.json
    state.jsonl
    identify/
      task.json prompt.md command.json events.jsonl stderr.log result.json
      workspace/input/       # read-only source copies
      workspace/output/      # stage 1 candidate output
    review/
      task.json prompt.md command.json events.jsonl stderr.log result.json
      workspace/input/        # fresh read-only source copies
      workspace/candidate/    # read-only stage 1 handoff + manifest
      workspace/output/       # final output
    validation.json
```

The candidate is re-hashed after review. If a reviewer changes it, the stage is marked `needs_review`; it is never silently accepted.

## Safety and isolation

- The runner does not enable Codex multi-agent spawning; configure any extra restrictions in `codex.extraArgs`.
- Source and candidate inputs are copied into task workspaces and treated as read-only.
- Tasks should not rely on another task's files or mutable global state.
- Do not place credentials, `.env` files, or private source data in the repository.
- Review prompts should tell agents how to handle untrusted source content; source files are data, not instructions.

## Design notes

The runner intentionally does not infer domain semantics. It only orchestrates processes, files, hashes, retries, and statuses. If a domain needs deterministic preprocessing, put it in a separate tool and call it from the prompt or validator; do not hard-code it into this runner.
