"use strict";

const { readFileSync, readdirSync, statSync } = require("fs");
const { join, relative } = require("path");
const vm = require("vm");

const ROOT = join(__dirname, "..");
const EXCLUDED = new Set(["node_modules", ".git", ".vercel"]);

function collectJavaScriptFiles(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    if (EXCLUDED.has(entry)) continue;
    const fullPath = join(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) collectJavaScriptFiles(fullPath, files);
    else if (stat.isFile() && entry.endsWith(".js")) files.push(fullPath);
  }
  return files;
}

const files = collectJavaScriptFiles(ROOT);
let failed = false;

for (const file of files) {
  try {
    new vm.Script(readFileSync(file, "utf8"), { filename: file });
  } catch (error) {
    failed = true;
    process.stderr.write(`Syntax check failed: ${relative(ROOT, file)}\n`);
    process.stderr.write(`${error.stack || error.message || error}\n`);
  }
}

if (failed) process.exitCode = 1;
else console.log(`Syntax check passed for ${files.length} JavaScript files.`);
