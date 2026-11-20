#!/usr/bin/env node
// Local smoke-test stand-in. It writes the required output and exits 0.
const fs = require("fs");
const path = require("path");
const cwd = process.cwd();
const stage = fs.existsSync(path.join(cwd, "candidate")) ? "review" : "identify";
const out = path.join(cwd, "output");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "result.txt"), `${stage}\n`, "utf8");
if (stage === "review") fs.writeFileSync(path.join(out, "final.json"), JSON.stringify({ status: "complete" }) + "\n", "utf8");
console.log(JSON.stringify({ type: "turn.completed", stage }));
