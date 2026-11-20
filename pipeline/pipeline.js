#!/usr/bin/env node
/**
 * Generic two-stage Codex batch runner.
 *
 * stage 1: an independent Codex session produces candidate/working output
 * stage 2: a fresh Codex session receives read-only candidate output and
 *          produces the final output
 *
 * The runner knows nothing about the task domain. Inputs, prompts, required
 * artifacts, candidate handoff, validation, and final status are configured
 * in config.json.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const RUNS = path.join(ROOT, CONFIG.runsDir || "runs");
const STAGES = ["identify", "review"];

const now = () => new Date().toISOString();
const ensure = (p) => fs.mkdirSync(p, { recursive: true });
const slash = (p) => p.split(path.sep).join("/");
const safeId = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "task";
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const shaText = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
function writeJson(file, value) { ensure(path.dirname(file)); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n"); fs.renameSync(tmp, file); }
function writeText(file, value) { ensure(path.dirname(file)); fs.writeFileSync(file, value, "utf8"); }
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function appendJsonl(file, value) { ensure(path.dirname(file)); fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8"); }
function resolveFrom(base, value) { return path.isAbsolute(value) ? value : path.resolve(base, value); }
function stageRoot(taskDir, stage) { return path.join(taskDir, stage); }
function workspace(taskDir, stage) { return path.join(stageRoot(taskDir, stage), "workspace"); }
function stageStatus(taskDir, stage) { return readJson(path.join(stageRoot(taskDir, stage), "status.json"), null); }

function codexBin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (CONFIG.codex && CONFIG.codex.binary) return CONFIG.codex.binary;
  const result = spawnSync(process.platform === "win32" ? "where" : "which", ["codex"], { encoding: "utf8" });
  return (result.stdout || "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) || "codex";
}
function codexIdentity(bin) {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return { binary: bin, version: (result.stdout || "").trim() || null };
}
function stageConfig(stage) { return (CONFIG.stages && CONFIG.stages[stage]) || {}; }
function required(stage) { return stageConfig(stage).requiredArtifacts || []; }
function configPath(value) { return resolveFrom(ROOT, value); }

function loadManifest(file) {
  const absolute = resolveFrom(process.cwd(), file);
  const base = path.dirname(absolute);
  const tasks = [];
  const ids = new Set();
  for (const [index, raw] of fs.readFileSync(absolute, "utf8").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let row;
    try { row = JSON.parse(line); } catch (e) { throw new Error(`${absolute}:${index + 1}: ${e.message}`); }
    if (!row || !row.id) throw new Error(`${absolute}:${index + 1}: task id is required`);
    const id = String(row.id);
    if (ids.has(id)) throw new Error(`${absolute}: duplicate task id ${id}`);
    ids.add(id);
    const entries = row.inputs || row.files || [];
    if (!Array.isArray(entries) || !entries.length) throw new Error(`${absolute}:${index + 1}: task ${id} needs inputs[]`);
    const inputs = entries.map((entry, n) => {
      const item = typeof entry === "string" ? { path: entry } : entry;
      if (!item || !item.path) throw new Error(`${absolute}:${index + 1}: input ${n + 1} has no path`);
      const source = resolveFrom(base, item.path);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`${absolute}:${index + 1}: input not found: ${source}`);
      return { source, name: item.name || path.basename(source), role: item.role || "input" };
    });
    tasks.push({ id, inputs, metadata: row.metadata || {}, notes: row.notes || "" });
  }
  if (!tasks.length) throw new Error(`manifest is empty: ${absolute}`);
  return { path: absolute, tasks };
}

function render(templateFile, task, stage, ws, candidate = "") {
  let text = fs.readFileSync(configPath(templateFile), "utf8");
  const replacements = {
    "{{TASK_ID}}": task.id,
    "{{STAGE}}": stage,
    "{{WORKSPACE}}": slash(ws),
    "{{INPUT_DIR}}": slash(path.join(ws, "input")),
    "{{INPUT_MANIFEST}}": slash(path.join(ws, "input", "manifest.json")),
    "{{OUTPUT_DIR}}": slash(path.join(ws, "output")),
    "{{CANDIDATE_DIR}}": candidate ? slash(path.join(ws, candidate)) : "(none)",
    "{{METADATA_JSON}}": JSON.stringify(task.metadata, null, 2),
    "{{NOTES}}": task.notes || "(none)",
  };
  for (const [key, value] of Object.entries(replacements)) text = text.split(key).join(value);
  return text;
}

function copyFileReadOnly(source, target) {
  ensure(path.dirname(target));
  fs.copyFileSync(source, target);
  try { fs.chmodSync(target, 0o444); } catch { /* Windows ACLs may ignore chmod */ }
}
function copyInputs(task, ws) {
  const input = path.join(ws, "input");
  ensure(input);
  const used = new Set();
  const files = task.inputs.map((item, index) => {
    let name = path.basename(item.name || path.basename(item.source));
    if (!name || name === "." || name === "..") name = `input_${index + 1}`;
    const original = name;
    let n = 2;
    while (used.has(name)) name = `${path.parse(original).name}_${n++}${path.extname(original)}`;
    used.add(name);
    const target = path.join(input, name);
    copyFileReadOnly(item.source, target);
    return { role: item.role, original_path: item.source, path: slash(path.relative(ws, target)), name, size: fs.statSync(target).size, sha256: sha256(target) };
  });
  writeJson(path.join(input, "manifest.json"), { task_id: task.id, files });
  return files;
}
function prepareBase(task, taskDir, stage) {
  const root = stageRoot(taskDir, stage);
  const ws = workspace(taskDir, stage);
  ensure(path.join(ws, "output"));
  const inputs = copyInputs(task, ws);
  const promptFile = stageConfig(stage).prompt;
  if (!promptFile) throw new Error(`config.stages.${stage}.prompt is required`);
  const prompt = render(promptFile, task, stage, ws, stage === "review" ? (CONFIG.candidate && CONFIG.candidate.target || "candidate") : "");
  writeText(path.join(root, "prompt.md"), prompt);
  writeJson(path.join(root, "task.json"), {
    id: task.id, stage, created_at: now(), inputs, metadata: task.metadata, notes: task.notes,
    required_artifacts: required(stage), prompt_sha256: shaText(prompt),
  });
  writeJson(path.join(root, "status.json"), { stage, status: "prepared", attempt: 1, updated_at: now() });
  combined(taskDir, { id: task.id, status: stageName(stage, "prepared"), [`${stage}_status`]: "prepared" });
  return { root, ws };
}

function listFiles(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const absolute = path.join(dir, name);
    const relative = prefix ? path.join(prefix, name) : name;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in candidate tree: ${absolute}`);
    if (stat.isDirectory()) result.push(...listFiles(absolute, relative));
    else if (stat.isFile()) result.push({ absolute, relative: slash(relative), size: stat.size, sha256: sha256(absolute) });
  }
  return result;
}
function copyTree(source, target, readOnly = false) {
  for (const entry of listFiles(source)) {
    const destination = path.join(target, entry.relative);
    ensure(path.dirname(destination));
    fs.copyFileSync(entry.absolute, destination);
    if (readOnly) { try { fs.chmodSync(destination, 0o444); } catch {} }
  }
}
function prepareReview(task, taskDir) {
  const source = path.join(workspace(taskDir, "identify"), "output");
  if (!fs.existsSync(source)) throw new Error(`identify output missing for ${task.id}`);
  const { root, ws } = prepareBase(task, taskDir, "review");
  const target = path.join(ws, CONFIG.candidate.target || "candidate");
  copyTree(source, target, CONFIG.candidate.readOnly !== false);
  const files = listFiles(target).map((x) => ({ path: slash(path.relative(ws, x.absolute)), size: x.size, sha256: x.sha256 }));
  writeJson(path.join(target, "candidate_manifest.json"), { task_id: task.id, source_stage: "identify", created_at: now(), files });
  return { root, ws };
}
function candidateIntegrity(taskDir) {
  const ws = workspace(taskDir, "review");
  const target = path.join(ws, CONFIG.candidate.target || "candidate");
  const manifest = readJson(path.join(target, "candidate_manifest.json"), null);
  if (!manifest || !Array.isArray(manifest.files)) return { ok: false, changed: [{ path: "candidate_manifest.json", reason: "missing" }] };
  const changed = [];
  for (const item of manifest.files) {
    const file = path.join(ws, item.path);
    if (!fs.existsSync(file)) changed.push({ path: item.path, reason: "missing" });
    else if (sha256(file) !== item.sha256) changed.push({ path: item.path, reason: "sha256 mismatch" });
  }
  return { ok: changed.length === 0, changed };
}
function inputIntegrity(root) {
  const task = readJson(path.join(root, "task.json"), null);
  const ws = path.join(root, "workspace");
  const changed = [];
  for (const item of (task && task.inputs) || []) {
    const file = path.join(ws, item.path);
    if (!fs.existsSync(file)) changed.push({ path: item.path, reason: "missing" });
    else if (sha256(file) !== item.sha256) changed.push({ path: item.path, reason: "sha256 mismatch" });
  }
  return { ok: changed.length === 0, changed };
}
function missingArtifacts(ws, artifacts) {
  return artifacts.filter((relative) => {
    const file = path.resolve(ws, relative);
    return !file.startsWith(path.resolve(ws)) || !fs.existsSync(file);
  });
}

function semaphore(limit) {
  let active = 0; const queue = [];
  const acquire = () => new Promise((resolve) => active < limit ? (active++, resolve()) : queue.push(resolve));
  const release = () => { active--; const next = queue.shift(); if (next) { active++; next(); } };
  return { async run(fn) { await acquire(); try { return await fn(); } finally { release(); } } };
}
function kill(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}
function commandFor(stage, root, ws, options) {
  const args = ["exec", "--cd", ws, "--skip-git-repo-check", "--sandbox", options.sandbox,
    "-c", `approval_policy="${CONFIG.codex.approvalPolicy || "never"}"`];
  if (options.effort) args.push("-c", `model_reasoning_effort="${options.effort}"`);
  args.push("--json", "--output-last-message", path.join(root, "final.md"));
  args.push(...(CONFIG.codex.extraArgs || []));
  if (options.model) args.push("--model", options.model);
  args.push("-");
  return { bin: options.codexBin, args };
}
function archiveStage(root) {
  const old = fs.readdirSync(root).filter((x) => /^attempt_\d+$/.test(x));
  const next = old.reduce((m, x) => Math.max(m, Number(x.slice(8))), 0) + 1;
  const archive = path.join(root, `attempt_${String(next).padStart(3, "0")}`); ensure(archive);
  for (const entry of fs.readdirSync(root)) if (path.basename(archive) !== entry && !/^attempt_\d+$/.test(entry)) fs.renameSync(path.join(root, entry), path.join(archive, entry));
  return next;
}
function combined(taskDir, patch) { const file = path.join(taskDir, "status.json"); const value = { ...readJson(file, {}), ...patch, updated_at: now() }; writeJson(file, value); appendJsonl(path.join(taskDir, "state.jsonl"), value); return value; }
function stageName(stage, status) { return `${stage}_${({ execution_completed: "completed", needs_review: "needs_review", planned: "planned" }[status] || status)}`; }

function runStage(task, taskDir, stage, options) {
  return new Promise((resolve, reject) => {
    const root = stageRoot(taskDir, stage); const ws = workspace(taskDir, stage);
    let attempt = 1;
    if (fs.existsSync(path.join(root, "result.json"))) { attempt = archiveStage(root) + 1; stage === "review" ? prepareReview(task, taskDir) : prepareBase(task, taskDir, stage); }
    const timeout = Number(stageConfig(stage).timeoutSeconds || options.timeoutSeconds);
    const command = commandFor(stage, root, ws, options);
    writeJson(path.join(root, "command.json"), { ...command, stage, attempt, cwd: ws, created_at: now(), codex: codexIdentity(options.codexBin) });
    if (options.dryRun) {
      const result = { stage, status: "planned", attempt, missing_artifacts: missingArtifacts(ws, required(stage)), created_at: now() };
      writeJson(path.join(root, "result.json"), result); writeJson(path.join(root, "status.json"), result); resolve(result); return;
    }
    const events = fs.createWriteStream(path.join(root, "events.jsonl"));
    const errors = fs.createWriteStream(path.join(root, "stderr.log"));
    const child = spawn(command.bin, command.args, { cwd: ws, env: { ...process.env, PYTHONUTF8: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32", shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command.bin) });
    const start = Date.now(); let lines = 0; let sessionId = null; let lastEvent = null; let pending = ""; let timedOut = false;
    const running = { stage, status: "running", attempt, pid: child.pid, started_at: now() }; writeJson(path.join(root, "status.json"), running); combined(taskDir, { status: stageName(stage, "running"), [`${stage}_status`]: "running", [`${stage}_attempt`]: attempt });
    child.stdout.on("data", (chunk) => { events.write(chunk); pending += chunk.toString(); const parts = pending.split(/\r?\n/); pending = parts.pop(); for (const line of parts) { if (!line.trim()) continue; lines++; try { const e = JSON.parse(line); lastEvent = e.type || lastEvent; sessionId = e.thread_id || e.session_id || sessionId; } catch {} } });
    child.stderr.on("data", (chunk) => errors.write(chunk)); child.on("error", (e) => errors.write(`spawn error: ${e.message}\n`));
    const heartbeat = setInterval(() => writeJson(path.join(root, "status.json"), { ...running, updated_at: now(), events: lines, last_event: lastEvent, session_id: sessionId }), 5000);
    const timer = setTimeout(() => { timedOut = true; kill(child); }, Math.max(1, timeout) * 1000);
    child.stdin.end(fs.readFileSync(path.join(root, "prompt.md"), "utf8"));
    child.on("close", (code) => {
      clearInterval(heartbeat); clearTimeout(timer); events.end(); errors.end();
      const missing = missingArtifacts(ws, required(stage)); const inputs = inputIntegrity(root); const candidate = stage === "review" ? candidateIntegrity(taskDir) : { ok: true, changed: [] };
      const status = timedOut ? "timeout" : code === 0 ? (missing.length || !inputs.ok || !candidate.ok ? "needs_review" : "execution_completed") : "failed";
      const result = { stage, status, attempt, exit_code: code, started_at: new Date(start).toISOString(), finished_at: now(), elapsed_seconds: Math.round((Date.now() - start) / 100) / 10, events: lines, last_event: lastEvent, session_id: sessionId, missing_artifacts: missing, input_integrity: inputs, candidate_integrity: candidate, workspace: ws };
      writeJson(path.join(root, "result.json"), result); writeJson(path.join(root, "status.json"), result); combined(taskDir, { status: stageName(stage, status), [`${stage}_status`]: status, [`${stage}_elapsed_seconds`]: result.elapsed_seconds, [`${stage}_missing`]: missing.length });
      console.log(JSON.stringify({ id: task.id, stage, status, exit_code: code, elapsed_seconds: result.elapsed_seconds, missing: missing.length })); resolve(result);
    });
  });
}
async function runWithRetries(task, taskDir, stage, options) {
  const retries = Number(stageConfig(stage).retries ?? options.retries); let result;
  for (let n = 0; n <= retries; n++) { result = await runStage(task, taskDir, stage, options); if (["execution_completed", "needs_review", "planned"].includes(result.status) || n === retries) break; }
  return result;
}

function finalStatus(taskDir) { const spec = CONFIG.finalStatus; if (!spec || !spec.path) return null; const value = readJson(path.join(workspace(taskDir, "review"), spec.path), null); return value && typeof value[spec.field || "status"] === "string" ? value[spec.field || "status"] : null; }
function deliveryStatus(validation, final) { if (validation === "not_configured") return final || "unvalidated"; if (!validation) return null; if (validation !== "verified") return validation; return ["complete", "partial", "failed"].includes(final) ? final : "verified_unstated"; }
function runValidation(taskDir) {
  const spec = CONFIG.validation || {}; const ws = workspace(taskDir, "review");
  if (!Array.isArray(spec.command) || !spec.command.length) return { status: "not_configured" };
  const replacements = { "{{WORKSPACE}}": ws, "{{TASK_ID}}": path.basename(taskDir) };
  const command = spec.command.map((x) => Object.entries(replacements).reduce((s, [a, b]) => s.split(a).join(b), x));
  const result = spawnSync(command[0], command.slice(1), { cwd: ws, encoding: "utf8", timeout: Number(spec.timeoutSeconds || 600), maxBuffer: 64 * 1024 * 1024, shell: false });
  const status = result.status === 0 ? "verified" : "validation_failed";
  writeJson(path.join(taskDir, "validation.json"), { status, command, exit_code: result.status, stdout: result.stdout || "", stderr: result.stderr || "", checked_at: now() });
  return { status };
}

function taskSummary(taskDir) { const status = readJson(path.join(taskDir, "status.json"), {}); const task = readJson(path.join(taskDir, "task.json"), {}); const final = finalStatus(taskDir); const validation = status.validation_status || null; return { id: status.id || task.id || path.basename(taskDir), status: status.status || "queued", identify_status: status.identify_status || null, review_status: status.review_status || null, validation_status: validation, review_final_status: final, delivery_status: deliveryStatus(validation, final) }; }
function writeSummary(runDir, rows = []) { const map = new Map(rows.map((x) => [x.id, x])); const dir = path.join(runDir, "tasks"); if (fs.existsSync(dir)) for (const id of fs.readdirSync(dir)) if (fs.statSync(path.join(dir, id)).isDirectory()) { const row = taskSummary(path.join(dir, id)); if (!map.has(row.id)) map.set(row.id, row); } const tasks = [...map.values()].sort((a, b) => a.id.localeCompare(b.id)); const counts = {}; const delivery_counts = {}; for (const row of tasks) { counts[row.status] = (counts[row.status] || 0) + 1; if (row.delivery_status) delivery_counts[row.delivery_status] = (delivery_counts[row.delivery_status] || 0) + 1; } const summary = { run_id: path.basename(runDir), updated_at: now(), counts, delivery_counts, tasks }; writeJson(path.join(runDir, "summary.json"), summary); return summary; }

function select(tasks, args) { let out = tasks; if (args.only) { const ids = new Set(args.only.split(",")); out = out.filter((x) => ids.has(x.id)); } if (args.offset) out = out.slice(args.offset); if (args.limit) out = out.slice(0, args.limit); return out; }
function newRun(id) { const dir = path.join(RUNS, id || `${Date.now()}_${crypto.randomBytes(3).toString("hex")}`); if (fs.existsSync(dir)) throw new Error(`run exists: ${dir}`); ensure(path.join(dir, "tasks")); return dir; }
function loadRun(id) { const dir = path.join(RUNS, id); if (!fs.existsSync(dir)) throw new Error(`run not found: ${dir}`); return dir; }
function ensureTask(task, runDir) { const dir = path.join(runDir, "tasks", safeId(task.id)); ensure(dir); return dir; }
async function processTask(task, runDir, options) {
  const dir = ensureTask(task, runDir); let identify = stageStatus(dir, "identify");
  if (!options.reviewOnly && !options.verifyOnly && (!identify || identify.status !== "execution_completed" || options.retryCompleted)) { prepareBase(task, dir, "identify"); identify = await options.identifySem.run(() => runWithRetries(task, dir, "identify", options)); }
  if (options.identifyOnly) return taskSummary(dir);
  if (!identify || !["execution_completed", "needs_review"].includes(identify.status)) return taskSummary(dir);
  let review = stageStatus(dir, "review");
  if (!options.verifyOnly && (!review || review.status !== "execution_completed" || options.retryCompleted)) { prepareReview(task, dir); review = await options.reviewSem.run(() => runWithRetries(task, dir, "review", options)); }
  if (review && ["execution_completed", "needs_review"].includes(review.status) && !options.skipValidation) { const validation = options.verifySem.run(() => runValidation(dir)); const result = await validation; const patch = { id: task.id, identify_status: identify.status, review_status: review.status }; if (result.status !== "not_configured") { patch.status = result.status === "verified" ? "verified" : result.status; patch.validation_status = result.status; } combined(dir, patch); }
  return taskSummary(dir);
}
async function pool(items, limit, worker) { let cursor = 0; const rows = []; await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => { while (cursor < items.length) { const item = items[cursor++]; rows.push(await worker(item)); } })); return rows; }

async function main() {
  const argv = process.argv.slice(2); const command = argv.shift() || "help"; const args = { manifest: "", run: "", runId: "", only: "", limit: 0, offset: 0, identifyConcurrency: CONFIG.pipeline.identifyConcurrency || 5, reviewConcurrency: CONFIG.pipeline.reviewConcurrency || 5, timeoutSeconds: CONFIG.pipeline.timeoutSeconds || 10800, retries: CONFIG.pipeline.retries ?? 1, sandbox: CONFIG.pipeline.sandbox || "workspace-write", model: CONFIG.codex.model || "", effort: CONFIG.codex.reasoningEffort || "high", dryRun: false, retryCompleted: false, identifyOnly: false, reviewOnly: false, verifyOnly: false, skipValidation: false };
  const value = () => { if (!argv.length) throw new Error("missing option value"); return argv.shift(); };
  while (argv.length) { const a = argv.shift(); if (a === "--manifest") args.manifest = value(); else if (a === "--run" || a === "--resume") args.run = value(); else if (a === "--run-id") args.runId = value(); else if (a === "--only") args.only = value(); else if (a === "--limit") args.limit = Number(value()); else if (a === "--offset") args.offset = Number(value()); else if (a === "--concurrency") args.identifyConcurrency = args.reviewConcurrency = Number(value()); else if (a === "--identify-concurrency") args.identifyConcurrency = Number(value()); else if (a === "--review-concurrency") args.reviewConcurrency = Number(value()); else if (a === "--timeout") args.timeoutSeconds = Number(value()); else if (a === "--retries") args.retries = Number(value()); else if (a === "--sandbox") args.sandbox = value(); else if (a === "--model") args.model = value(); else if (a === "--effort") args.effort = value(); else if (a === "--dry-run") args.dryRun = true; else if (a === "--retry-completed") args.retryCompleted = true; else if (a === "--identify-only") args.identifyOnly = true; else if (a === "--review-only") args.reviewOnly = true; else if (a === "--verify-only") args.verifyOnly = true; else if (a === "--skip-validation") args.skipValidation = true; else if (a === "--help") return usage(); else throw new Error(`unknown option ${a}`); }
  if (command === "prepare") { const manifest = loadManifest(args.manifest); const run = newRun(args.runId); const tasks = select(manifest.tasks, args); writeJson(path.join(run, "run.json"), { run_id: path.basename(run), manifest: manifest.path, created_at: now(), task_count: tasks.length }); writeText(path.join(run, "manifest.jsonl"), tasks.map((x) => JSON.stringify(x)).join("\n") + "\n"); for (const task of tasks) { const dir = ensureTask(task, run); prepareBase(task, dir, "identify"); } console.log(JSON.stringify({ run_dir: run, prepared: tasks.length }, null, 2)); return; }
  if (!["run", "all", "verify", "status", "summary"].includes(command)) return usage();
  const run = command === "verify" || command === "status" || command === "summary" ? loadRun(args.run) : args.run ? loadRun(args.run) : newRun(args.runId);
  let tasks;
  if (command === "run" || command === "all") { const manifest = loadManifest(args.manifest); if (args.run) { const ids = new Set(fs.readFileSync(path.join(run, "manifest.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((x) => JSON.parse(x).id)); tasks = manifest.tasks.filter((x) => ids.has(x.id)); } else { tasks = select(manifest.tasks, args); writeText(path.join(run, "manifest.jsonl"), tasks.map((x) => JSON.stringify(x)).join("\n") + "\n"); writeJson(path.join(run, "run.json"), { run_id: path.basename(run), manifest: manifest.path, created_at: now(), task_count: tasks.length }); } const options = { ...args, codexBin: codexBin(), identifySem: semaphore(args.identifyConcurrency), reviewSem: semaphore(args.reviewConcurrency), verifySem: semaphore(args.reviewConcurrency) }; const rows = await pool(tasks, args.identifyConcurrency + args.reviewConcurrency, async (task) => { try { return await processTask(task, run, options); } catch (e) { const dir = ensureTask(task, run); combined(dir, { id: task.id, status: "pipeline_error", error: e.stack || e.message }); console.error(JSON.stringify({ id: task.id, status: "pipeline_error", error: e.message })); return taskSummary(dir); } }); const summary = writeSummary(run, rows); console.log(JSON.stringify({ run_dir: run, counts: summary.counts, delivery_counts: summary.delivery_counts }, null, 2)); return; }
  if (command === "verify") { const dirs = fs.readdirSync(path.join(run, "tasks")).filter((x) => fs.existsSync(path.join(run, "tasks", x, "review", "workspace"))); for (const id of dirs) { const result = runValidation(path.join(run, "tasks", id)); combined(path.join(run, "tasks", id), { validation_status: result.status, status: result.status }); } }
  const summary = writeSummary(run); if (command === "status" || command === "summary" || command === "verify") console.log(JSON.stringify(summary, null, 2));
}
function usage() { console.log(`Generic two-stage Codex batch runner\n\nnode pipeline/pipeline.js run --manifest manifest.jsonl [options]\nnode pipeline/pipeline.js prepare --manifest manifest.jsonl\nnode pipeline/pipeline.js verify --run RUN_ID\nnode pipeline/pipeline.js status --run RUN_ID\nnode pipeline/pipeline.js summary --run RUN_ID\n\nManifest rows: {"id":"...","inputs":[{"path":"file","name":"optional"}],"metadata":{},"notes":""}\n`); }
main().catch((error) => { console.error(`pipeline: ${error.stack || error.message}`); process.exitCode = 1; });
