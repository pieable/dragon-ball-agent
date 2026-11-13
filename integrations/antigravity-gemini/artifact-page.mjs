import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runtimeConfig } from './runtime-config.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readRegular = file => fs.readFile(file);

export async function readArtifactPage(file, artifact, { offset = 0, length = runtimeConfig.artifactPageBytes } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 ||
      length > runtimeConfig.artifactPageBytes) {
    throw new Error(`Artifact offsets must be nonnegative safe integers and page length must be at most ${runtimeConfig.artifactPageBytes} bytes.`);
  }
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Artifact must be a regular file.');
  const bytes = await readRegular(file);
  if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256) throw new Error('Artifact hash or size changed.');
  if (offset > bytes.length) throw new Error('Artifact offset is past the end of the file.');
  const textual = /^text\//i.test(artifact.mime_type) || artifact.mime_type === 'application/json' || /\+json$/i.test(artifact.mime_type);
  let actualOffset = offset;
  let next = Math.min(bytes.length, actualOffset + length);
  let content;
  let contentEncoding;
  if (textual) {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    decoder.decode(bytes);
    while (actualOffset > 0 && actualOffset < bytes.length && (bytes[actualOffset] & 0xc0) === 0x80) actualOffset--;
    while (next > actualOffset && next < bytes.length && (bytes[next] & 0xc0) === 0x80) next--;
    if (next === actualOffset && actualOffset < bytes.length) {
      next = Math.min(bytes.length, actualOffset + 4);
      while (next < bytes.length && (bytes[next] & 0xc0) === 0x80) next++;
    }
    content = decoder.decode(bytes.subarray(actualOffset, next));
    contentEncoding = 'utf-8';
  } else {
    content = bytes.subarray(actualOffset, next).toString('base64');
    contentEncoding = 'base64';
  }
  return { name: artifact.name, mime_type: artifact.mime_type, total_bytes: bytes.length,
    sha256: artifact.sha256, requested_offset: offset, offset: actualOffset, next_offset: next,
    eof: next >= bytes.length, content_encoding: contentEncoding, content };
}
