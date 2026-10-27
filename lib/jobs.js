import { randomUUID } from 'node:crypto';

// Finished jobs are kept for an hour so the client can collect the result.
const RETENTION_MS = 60 * 60 * 1000;

const jobs = new Map();

function prune() {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
  }
}

/** Starts fn in the background and tracks it under a short ID. */
export function startJob(label, fn) {
  prune();
  const job = {
    id: `job_${randomUUID().slice(0, 8)}`,
    label,
    startedAt: Date.now(),
    finishedAt: undefined,
    result: undefined,
    error: undefined,
  };
  job.promise = Promise.resolve()
    .then(fn)
    .then(
      (result) => {
        job.result = result;
      },
      (error) => {
        job.error = error;
      },
    )
    .finally(() => {
      job.finishedAt = Date.now();
    });
  jobs.set(job.id, job);
  return job;
}

export function getJob(id) {
  prune();
  return jobs.get(id);
}

/** Resolves true when the job finished within ms, false otherwise. ms <= 0 waits indefinitely. */
export async function waitForJob(job, ms) {
  if (job.finishedAt) return true;
  if (ms <= 0) {
    await job.promise;
    return true;
  }
  let timer;
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  const done = job.promise.then(() => true);
  try {
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function elapsedSeconds(job) {
  return Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000);
}
