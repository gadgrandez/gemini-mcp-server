import { z } from 'zod';
import { jobStatus } from './result.js';

export function registerJobTools(server) {
  server.registerTool(
    'gemini_job_status',
    {
      title: 'Collect a running Gemini job',
      description:
        'Collect the result of a tool call that returned a job ID because it was still running ' +
        '(long videos, large uploads, long transcriptions). Returns the result when ready; otherwise ' +
        'reports that the job is still running, and can be called again.',
      inputSchema: {
        jobId: z.string().describe('Job ID returned by the earlier tool call, e.g. "job_1a2b3c4d"'),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .default(40)
          .describe('Seconds to wait for the job before returning; capped by GEMINI_SYNC_WAIT_SECONDS'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ jobId, waitSeconds }, extra) => jobStatus(extra, jobId, waitSeconds * 1000),
  );
}
