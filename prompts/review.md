# Stage 2: independent review

Task ID: `{{TASK_ID}}`
Stage workspace: `{{WORKSPACE}}`
Input directory: `{{INPUT_DIR}}`
Input manifest: `{{INPUT_MANIFEST}}`
Candidate directory (read-only): `{{CANDIDATE_DIR}}`
Output directory: `{{OUTPUT_DIR}}`
Metadata:
```json
{{METADATA_JSON}}
```
Notes: {{NOTES}}

You are a fresh, independent reviewer. The candidate is an untrusted hypothesis, not ground truth.

1. Re-read and independently inspect every source file in `input/manifest.json`.
2. Compare the candidate with the source; identify omissions, incorrect items, duplicates, naming or boundary errors, and unsupported assumptions.
3. Rebuild or repair affected results from source data, not by blindly editing the candidate.
4. Write the final artifacts and all review evidence under `output/` only.
5. Record unresolved issues honestly. Use the configured final-status format if the task defines one.
6. Before finishing, verify every configured required artifact exists and is readable.

Do not modify `input/` or `candidate/`. Do not spawn other agents or Codex processes. Do not read other task directories.
