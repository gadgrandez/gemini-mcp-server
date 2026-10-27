import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { ai, config } from './config.js';

// MIME types accepted by the Gemini Interactions API, keyed by file extension.
const MIME_BY_KIND = {
  video: {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mpeg: 'video/mpeg',
    mpg: 'video/mpg',
    mov: 'video/mov',
    avi: 'video/avi',
    flv: 'video/x-flv',
    webm: 'video/webm',
    wmv: 'video/wmv',
    '3gp': 'video/3gpp',
  },
  audio: {
    wav: 'audio/wav',
    mp3: 'audio/mp3',
    aiff: 'audio/aiff',
    aif: 'audio/aiff',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/m4a',
    opus: 'audio/opus',
    webm: 'audio/webm',
  },
  image: {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    gif: 'image/gif',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
  },
  document: {
    pdf: 'application/pdf',
    csv: 'text/csv',
  },
};

const YOUTUBE_RE = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i;
const FILE_NAME_RE = /^files\/[\w-]+$/;

function extensionOf(pathOrUrl) {
  const clean = pathOrUrl.split(/[?#]/)[0];
  return extname(clean).slice(1).toLowerCase();
}

export function guessMime(pathOrUrl) {
  const ext = extensionOf(pathOrUrl);
  for (const kind of ['video', 'audio', 'image', 'document']) {
    if (MIME_BY_KIND[kind][ext]) return MIME_BY_KIND[kind][ext];
  }
  return undefined;
}

export function kindOf(pathOrUrl) {
  const ext = extensionOf(pathOrUrl);
  for (const kind of ['video', 'audio', 'image', 'document']) {
    if (MIME_BY_KIND[kind][ext]) return kind;
  }
  return undefined;
}

/** Converts an Interactions API content block into a generateContent Part. */
export function toPart(block) {
  if (block.data) return { inlineData: { data: block.data, mimeType: block.mime_type } };
  const fileData = { fileUri: block.uri };
  if (block.mime_type) fileData.mimeType = block.mime_type;
  return { fileData };
}

export function mimeFor(kind, pathOrUrl, override) {
  if (override) return override;
  const ext = extensionOf(pathOrUrl);
  const mime = MIME_BY_KIND[kind][ext];
  if (!mime) {
    const supported = Object.keys(MIME_BY_KIND[kind]).join(', ');
    throw new Error(
      `Cannot infer a supported ${kind} MIME type from "${basename(pathOrUrl)}". ` +
        `Supported extensions: ${supported}. Pass mimeType explicitly, or convert the file ` +
        `(for example with ffmpeg) to a supported format.`,
    );
  }
  return mime;
}

async function waitUntilActive(file) {
  let current = file;
  const deadline = Date.now() + config.timeoutMs;
  while (current.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${current.name} to finish processing`);
    await new Promise((r) => setTimeout(r, 3000));
    current = await ai.files.get({ name: current.name });
  }
  if (current.state === 'FAILED') {
    throw new Error(`Gemini failed to process ${current.name}: ${current.error?.message || 'unknown error'}`);
  }
  return current;
}

export async function uploadFile(filePath, mimeType, displayName) {
  const uploaded = await ai.files.upload({
    file: filePath,
    config: { mimeType, displayName: displayName || basename(filePath) },
  });
  return waitUntilActive(uploaded);
}

/**
 * Turns a user-supplied source into an Interactions API content block.
 *
 * Accepted sources: an absolute local path, a Files API name ("files/abc123"),
 * an https URL, a gs:// URI, or (for video) a public YouTube URL.
 *
 * Returns { block, cleanup } where cleanup deletes any file uploaded on the
 * caller's behalf, unless GEMINI_KEEP_UPLOADS or options.keepUpload is set.
 */
export async function resolveSource(kind, source, mimeTypeOverride, options = {}) {
  const noop = async () => {};
  if (!source || typeof source !== 'string') throw new Error('source is required');
  const trimmed = source.trim();

  if (FILE_NAME_RE.test(trimmed)) {
    const file = await waitUntilActive(await ai.files.get({ name: trimmed }));
    return {
      block: { type: kind, uri: file.uri, mime_type: mimeTypeOverride || file.mimeType },
      cleanup: noop,
      note: `Files API: ${file.name}`,
    };
  }

  if (YOUTUBE_RE.test(trimmed)) {
    if (kind !== 'video') throw new Error('YouTube URLs are only supported by gemini_analyze_video');
    return { block: { type: 'video', uri: trimmed }, cleanup: noop };
  }

  if (/^(https?|gs):\/\//i.test(trimmed)) {
    return {
      block: { type: kind, uri: trimmed, mime_type: mimeFor(kind, trimmed, mimeTypeOverride) },
      cleanup: noop,
    };
  }

  if (!isAbsolute(trimmed)) {
    throw new Error(
      'source must be an absolute local path, a Files API name (files/...), an https:// URL, ' +
        'a gs:// URI, or a YouTube URL',
    );
  }

  const filePath = resolve(trimmed);
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);

  const mimeType = mimeFor(kind, filePath, mimeTypeOverride);

  if (info.size <= config.inlineMaxBytes) {
    const data = (await readFile(filePath)).toString('base64');
    return { block: { type: kind, data, mime_type: mimeType }, cleanup: noop };
  }

  const file = await uploadFile(filePath, mimeType);
  const keep = config.keepUploads || options.keepUpload;
  const cleanup = keep
    ? noop
    : async () => {
        try {
          await ai.files.delete({ name: file.name });
        } catch (e) {
          process.stderr.write(`Could not delete ${file.name}: ${e.message}\n`);
        }
      };
  return {
    block: { type: kind, uri: file.uri, mime_type: file.mimeType || mimeType },
    cleanup,
    note: keep
      ? `Uploaded to Files API as ${file.name} (kept for 48 hours; reuse it as source to skip the upload)`
      : undefined,
  };
}
