import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = String(process.env.APP_BASE_URL || "https://newhunaken456.vercel.app").replace(/\/$/, "");
const TOKEN = String(process.env.CAPTURE_TOKEN || "");
const PRIMARY_RUNNER_NAME = String(process.env.PRIMARY_RUNNER_NAME || "github-actions-primary");
const SECONDARY_RUNNER_NAME = String(process.env.SECONDARY_RUNNER_NAME || "cloud-run-secondary");
const PRIMARY_MAX_AGE_MINUTES = Math.max(3, Math.min(30, Number(process.env.PRIMARY_MAX_AGE_MINUTES || 7)));
const RUNNING_MAX_AGE_MINUTES = Math.max(5, Math.min(60, Number(process.env.RUNNING_MAX_AGE_MINUTES || 20)));
const FORCE_SECONDARY_RUN = /^(1|true|yes)$/i.test(String(process.env.FORCE_SECONDARY_RUN || ""));
const PIPELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "capture_all_active_races.mjs");

async function getRunnerStatus(runner) {
  const qs = new URLSearchParams({ action: "capture_runner_status", runner, t: String(Date.now()) });
  const response = await fetch(`${BASE}/api/yoso?${qs}`, {
    headers: TOKEN ? { "x-capture-token": TOKEN } : {},
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok || !data.ok) throw new Error(`${response.status} ${data.error || text.slice(0, 180)}`);
  return data;
}

function ageMinutes(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? Math.max(0, (Date.now() - ms) / 60000) : Number.POSITIVE_INFINITY;
}

function runMainPipeline() {
  const executionName = String(process.env.CLOUD_RUN_EXECUTION || process.env.K_REVISION || "cloud-run");
  const runId = `${SECONDARY_RUNNER_NAME}-${executionName}-${Date.now()}`.slice(0, 160);
  console.log(`SECONDARY RUN start: primary is stale/unavailable; runId=${runId}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PIPELINE_PATH], {
      stdio: "inherit",
      env: {
        ...process.env,
        RUNNER_NAME: SECONDARY_RUNNER_NAME,
        RUN_ID: runId,
      },
    });
    child.on("error", (error) => {
      console.error(`secondary spawn failed: ${error.message || error}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) console.error(`secondary pipeline terminated by signal ${signal}`);
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

let shouldRun = FORCE_SECONDARY_RUN;
if (FORCE_SECONDARY_RUN) {
  console.log("SECONDARY FORCE RUN: FORCE_SECONDARY_RUN is enabled");
} else {
  try {
    const secondary = await getRunnerStatus(SECONDARY_RUNNER_NAME);
    const secondaryHeartbeat = secondary?.heartbeat || null;
    const secondaryRunningAge = ageMinutes(secondaryHeartbeat?.startedAt || secondaryHeartbeat?.updatedAt);
    if (secondaryHeartbeat?.state === "running" && secondaryRunningAge <= RUNNING_MAX_AGE_MINUTES) {
      console.log(`SECONDARY SKIP: another secondary run is active (${secondaryRunningAge.toFixed(1)} min)`);
      process.exit(0);
    }
  } catch (error) {
    // 自分自身の状態確認に失敗しても、主系監視は継続する。
    console.warn(`secondary status check failed: ${error.message || error}`);
  }

  try {
    const primary = await getRunnerStatus(PRIMARY_RUNNER_NAME);
    const heartbeat = primary?.heartbeat || null;
    const runningAge = ageMinutes(heartbeat?.startedAt || heartbeat?.updatedAt);
    const successAge = ageMinutes(heartbeat?.finishedAt || heartbeat?.updatedAt);

    if (heartbeat?.state === "running" && runningAge <= RUNNING_MAX_AGE_MINUTES) {
      console.log(`SECONDARY SKIP: primary is running (${runningAge.toFixed(1)} min)`);
      process.exit(0);
    }
    if (heartbeat?.state === "success" && successAge <= PRIMARY_MAX_AGE_MINUTES) {
      console.log(`SECONDARY SKIP: primary success is fresh (${successAge.toFixed(1)} min <= ${PRIMARY_MAX_AGE_MINUTES} min)`);
      process.exit(0);
    }

    console.warn(`PRIMARY STALE: found=${!!heartbeat} state=${heartbeat?.state || "none"} age=${successAge.toFixed(1)} min`);
    shouldRun = true;
  } catch (error) {
    // 主系状態を確認できない時は、安全側で副系を実行する。
    console.warn(`PRIMARY STATUS UNAVAILABLE: ${error.message || error}`);
    shouldRun = true;
  }
}

if (!shouldRun) process.exit(0);
const exitCode = await runMainPipeline();
process.exit(exitCode);
