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
