# Stage 1: identify

Task ID: `{{TASK_ID}}`
Stage workspace: `{{WORKSPACE}}`
Input directory: `{{INPUT_DIR}}`
Input manifest: `{{INPUT_MANIFEST}}`
Output directory: `{{OUTPUT_DIR}}`
Metadata:
```json
{{METADATA_JSON}}
```
Notes: {{NOTES}}

You are the first, independent worker in a two-stage batch job.

1. Read every file listed in `input/manifest.json` and inspect the source data directly.
2. Perform the task described by the project contract or the task metadata.
3. Write all candidate artifacts under `output/` only.
4. Record source references, assumptions, exclusions, uncertainty, and checks when the task requires them.
5. Do not claim final acceptance. Mark the result as candidate/ready for review where the task format supports status.

Do not spawn other agents or Codex processes. Do not modify `input/`. Do not read other task directories.
Before finishing, verify every configured required artifact exists and is readable.
