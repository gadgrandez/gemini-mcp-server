import { config } from '../lib/config.js';
import { startJob, getJob, waitForJob, elapsedSeconds } from '../lib/jobs.js';

export function success(text) {
  return { content: [{ type: 'text', text }] };
}

export function failure(e) {
  return {
    content: [{ type: 'text', text: `Error: ${e?.message || String(e)}` }],
    isError: true,
  };
}

const HEARTBEAT_MS = Number.parseInt(process.env.GEMINI_PROGRESS_INTERVAL_MS || '', 10) || 10_000;

/**
 * Runs a long tool call while sending MCP progress notifications every few
 * seconds, so clients that reset their request timeout on progress keep
 * waiting for long uploads and long video analyses.
 */
export async function withHeartbeat(extra, label, fn) {
  const token = extra?._meta?.progressToken;
  if (token === undefined || typeof extra?.sendNotification !== 'function') return fn();

  const startedAt = Date.now();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: ticks, message: `${label} (${seconds}s elapsed)` },
      })
      .catch(() => {});
  }, HEARTBEAT_MS);
  timer.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

function pendingResult(job) {
  return success(
    `Still running after ${elapsedSeconds(job)}s: ${job.label}.\n` +
      `Job ID: ${job.id}\n\n` +
      'The work continues in the background. Call gemini_job_status with this job ID to collect the result.',
  );
}

function finishedResult(job) {
  return job.error ? failure(job.error) : job.result;
}

/**
 * Runs fn as a background job and waits up to GEMINI_SYNC_WAIT_SECONDS for it.
 * Calls that finish in time return their result directly; longer ones return a
 * job ID for gemini_job_status, so no single tool call outlives client or
 * bridge timeouts.
 */
export async function withDeadline(extra, label, fn) {
  const job = startJob(label, fn);
  const done = await withHeartbeat(extra, label, () => waitForJob(job, config.syncWaitMs));
  return done ? finishedResult(job) : pendingResult(job);
}

/** Waits up to waitMs (capped by GEMINI_SYNC_WAIT_SECONDS) for an existing job. */
export async function jobStatus(extra, jobId, waitMs) {
  const job = getJob(jobId);
  if (!job) {
    return failure(
      new Error(
        `Unknown job ${jobId}. Jobs live in the server process and are kept for an hour after they ` +
          'finish; a restart of the MCP server discards them.',
      ),
    );
  }
  const cap = config.syncWaitMs > 0 ? Math.min(waitMs, config.syncWaitMs) : waitMs;
  const done = await withHeartbeat(extra, job.label, () => waitForJob(job, Math.max(cap, 1)));
  return done ? finishedResult(job) : pendingResult(job);
}
