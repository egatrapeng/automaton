/** Run from repository root: node --import tsx scripts/benchmark-context.ts */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { createTokenCounter } from "../src/memory/context-manager.js";

function readLimit(file: string): string | null {
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return null; }
}

// Run the previous unbounded algorithm in its own process so its CPU cost
// cannot freeze this benchmark. A timeout is a lower bound, not a measurement
// of eventual completion. No runtime controls or assertions are disabled.
const baselineCode = `
import {getEncoding} from 'js-tiktoken';
import {performance} from 'node:perf_hooks';
const encoder = getEncoding('cl100k_base');
const start = performance.now();
const count = encoder.encode('x'.repeat(50000)).length;
console.log(JSON.stringify({durationMs: performance.now()-start, count}));
`;
const baselineStart = performance.now();
const baseline = spawnSync(process.execPath, ["--input-type=module", "-e", baselineCode], {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: 2_500,
  killSignal: "SIGKILL",
  maxBuffer: 64 * 1024,
});
const baselineResult = baseline.error
  ? { status: (baseline.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : "error", elapsedMs: performance.now() - baselineStart, error: (baseline.error as NodeJS.ErrnoException).code }
  : baseline.status === 0
    ? { status: "completed", ...JSON.parse(baseline.stdout) }
    : { status: "failed", exitCode: baseline.status, stderr: baseline.stderr.slice(0, 500) };

const counter = createTokenCounter();
const warmupStart = performance.now();
counter.countTokens("Initialize short-input encoder");
const warmupMs = performance.now() - warmupStart;

function measure(name: string, makeText: (iteration: number) => string) {
  const samples: number[] = [];
  let count = 0;
  for (let i = 0; i < 100; i++) {
    const text = makeText(i);
    const start = performance.now();
    count = counter.countTokens(text);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { name, iterations: samples.length, p50Ms: samples[50], p95Ms: samples[95], lastTokenBudget: count };
}

console.log(JSON.stringify({
  node: process.version,
  resourceContext: {
    cpuQuota: readLimit("/sys/fs/cgroup/cpu.max"),
    memoryLimitBytes: readLimit("/sys/fs/cgroup/memory.max"),
    availableParallelism: os.availableParallelism(),
    note: "Synthetic token-counter benchmark, not a production VPS or provider throughput benchmark.",
  },
  previousRepeated50k: baselineResult,
  shortEncoderInitializationMs: warmupMs,
  current: [
    measure("short independent messages", i => `Task ${i}: inspect and summarize the source files, then run the tests.`),
    measure("50k repeated ASCII", () => "x".repeat(50_000)),
    measure("500k repeated ASCII", () => "x".repeat(500_000)),
    measure("long Unicode", () => "漢😀".repeat(10_000)),
  ],
  retainedCacheEntries: counter.cache.size,
  retainedCacheKeyBytes: [...counter.cache.keys()].reduce((sum, key) => sum + key.length * 2, 0),
  processMemoryBytes: process.memoryUsage(),
}, null, 2));
