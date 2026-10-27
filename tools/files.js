import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { ai } from '../lib/config.js';
import { guessMime, uploadFile } from '../lib/sources.js';
import { success, failure, withHeartbeat } from './result.js';

function describeFile(file) {
  return [
    `Name: ${file.name}`,
    file.displayName ? `Display name: ${file.displayName}` : undefined,
    `MIME: ${file.mimeType}`,
    `Size: ${file.sizeBytes} bytes`,
    `State: ${file.state}`,
    `Expires: ${file.expirationTime || 'N/A'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function registerFileTools(server) {
  server.registerTool(
    'gemini_upload_file',
    {
      title: 'Upload a file to Gemini',
      description:
        'Upload a local file to the Gemini Files API once and reuse its name (files/...) as the source ' +
        'for several analysis calls, which avoids re-uploading large videos. Files expire after 48 hours.',
      inputSchema: {
        filePath: z.string().describe('Absolute path to the local file'),
        mimeType: z
          .string()
          .optional()
          .describe('MIME type override; inferred from the extension when omitted'),
        displayName: z.string().optional().describe('Display name for the uploaded file'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ filePath, mimeType, displayName }, extra) =>
      withHeartbeat(extra, 'Uploading to Gemini', async () => {
        try {
          if (!isAbsolute(filePath)) throw new Error('filePath must be an absolute path');
          const resolved = resolve(filePath);
          const info = await stat(resolved).catch(() => {
            throw new Error(`File not found: ${resolved}`);
          });
          if (!info.isFile()) throw new Error(`Not a file: ${resolved}`);
          const mime = mimeType || guessMime(resolved);
          if (!mime) throw new Error('Cannot infer the MIME type from the extension; pass mimeType');
          const file = await uploadFile(resolved, mime, displayName);
          return success(
            `File uploaded.\n${describeFile(file)}\n\nUse "${file.name}" as the source in the analysis tools.`,
          );
        } catch (e) {
          return failure(e);
        }
      }),
  );

  server.registerTool(
    'gemini_list_files',
    {
      title: 'List files uploaded to Gemini',
      description: 'List files currently stored in the Gemini Files API for this API key.',
      inputSchema: {
        pageSize: z.number().int().min(1).max(100).default(20).describe('Maximum number of files to list'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ pageSize }) => {
      try {
        const files = [];
        const pager = await ai.files.list({ config: { pageSize } });
        for await (const file of pager) {
          files.push(describeFile(file));
          if (files.length >= pageSize) break;
        }
        if (files.length === 0) return success('No files uploaded.');
        return success(`Uploaded files (${files.length}):\n\n${files.join('\n\n')}`);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'gemini_delete_file',
    {
      title: 'Delete a file from Gemini',
      description: 'Delete a file from the Gemini Files API by its name (files/...).',
      inputSchema: {
        fileName: z
          .string()
          .regex(/^files\/[\w-]+$/)
          .describe('File name, e.g. "files/abc123"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ fileName }) => {
      try {
        await ai.files.delete({ name: fileName });
        return success(`Deleted ${fileName}.`);
      } catch (e) {
        return failure(e);
      }
    },
  );
}
