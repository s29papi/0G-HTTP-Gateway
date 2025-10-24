// src/gateway.ts (drop-in updated)
import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import { ethers } from "ethers";
import { NETWORKS } from '@searchboxlabs/metalayer/dist/network';
import MetaLayerClient from '@searchboxlabs/metalayer';
import { LRUCache } from 'lru-cache';
import fsp from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import { Indexer } from '@0glabs/0g-ts-sdk';
import mime from 'mime';
import fs from 'fs';

dotenv.config();
const PORT = Number(process.env.PORT || 3000);
const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'og-gateway-tmp');

const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 200);
const CACHE_MAX_AGE_MS = Number(process.env.CACHE_MAX_AGE_MS || 1000 * 60 * 60); // 1 hour

const app = express();
const client = new MetaLayerClient();
const indexer = new Indexer(NETWORKS.testnet.indexerUrl);

type DownloadPromise = Promise<string>; // resolves to filepath
const downloadLocks = new Map<string, DownloadPromise>(); // dedupe concurrent downloads

// ensure temp dir exists
(async () => {
  await fsp.mkdir(TMP_DIR, { recursive: true });
})();

// serve static public files (video-player.html, sw-chunked.js, etc.)
app.use(express.static('public'));

// simple LRU for disk-cached files (stores metadata only)
// IMPORTANT: dispose must be synchronous; don't `await` in dispose.
const cache = new LRUCache<string, { path: string; size: number; addedAt: number }>({
  max: CACHE_MAX_ENTRIES,
  ttl: CACHE_MAX_AGE_MS,
  dispose: (value, key) => {
    // best-effort delete, fire-and-forget
    fsp.unlink(value.path).catch(() => {});
  },
});

function isValidRootHash(rootHash: any) {
  return (
    typeof rootHash === "string" &&
    rootHash.startsWith("0x") &&
    rootHash.length === 66 &&
    /^0x[0-9a-fA-F]+$/.test(rootHash)
  );
}

function safeName(rootHash: string) {
  const s = rootHash.startsWith('0x') ? rootHash.slice(2) : rootHash;
  return s.replace(/[^0-9a-fA-F]/g, '').slice(0, 128) || Date.now().toString(36);
}

async function maybeGetOnchainCtx(rootHash: string) {
  try {
    // Try unsigned first — older MetaLayer versions may accept undefined signer.
    
      const provider = new ethers.JsonRpcProvider(NETWORKS.testnet.rpcUrl);
      const signer = new ethers.Wallet(rootHash, provider); // legacy behavior retained
      return await client.getOnchainAwareCtx(rootHash, NETWORKS.testnet, signer);
    
  } catch (e) {
    console.warn('onchain ctx fetch failed:', (e as Error).message);
    return null;
  }
}

function makeETag(stat: fs.Stats) {
  const mtime = Math.floor((stat.mtimeMs || 0));
  const size = stat.size || 0;
  return `"${size.toString(16)}-${mtime.toString(16)}"`;
}

function resolveContentType(filePath: string, encodedCtx: any) {
  if (encodedCtx?.contentType && typeof encodedCtx.contentType === 'string') return encodedCtx.contentType;
  if (encodedCtx?.extension && typeof encodedCtx.extension === 'string') {
    const t = mime.getType(encodedCtx.extension);
    if (t) return t;
  }
  const ext = path.extname(filePath);
  return mime.getType(ext) || 'application/octet-stream';
}

/**
 * tryDirectStreamFromIndexer
 *
 * Tries several common streaming method shapes on the `indexer` instance to
 * avoid writing to disk. If successful, pipes bytes to `res` and resolves.
 * If none are available or all attempts fail, throws an error to let caller fallback.
 */
async function tryDirectStreamFromIndexer(rootHash: string, res: Response) {
  const iv: any = indexer as any;

  // Gather candidate function names that libraries commonly offer.
  const candidates: Array<{ fn: Function; shape: 'root-writable' | 'readable-return' }> = [];

  if (iv.downloadToStream && typeof iv.downloadToStream === 'function') candidates.push({ fn: iv.downloadToStream.bind(iv), shape: 'root-writable' });
  if (iv.downloadStream && typeof iv.downloadStream === 'function') candidates.push({ fn: iv.downloadStream.bind(iv), shape: 'root-writable' });
  if (iv.stream && typeof iv.stream === 'function') candidates.push({ fn: iv.stream.bind(iv), shape: 'readable-return' });
  if (iv.download && typeof iv.download === 'function') {
    // some SDKs implement download(rootHash, target) where target could be a writable stream.
    candidates.push({ fn: iv.download.bind(iv), shape: 'root-writable' });
  }

  if (candidates.length === 0) {
    throw new Error('no candidate streaming methods found on indexer');
  }

  // prepare HTTP headers for streaming
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Content-Disposition', `inline; filename="${rootHash}"`);
  // Try each candidate until one works
  let lastErr: any = null;
  for (const c of candidates) {
    try {
      if (c.shape === 'root-writable') {
        // call function with (rootHash, res) signature
        const maybe = c.fn(rootHash, res);
        // If returns a promise, await it
        if (maybe && typeof maybe.then === 'function') {
          await maybe;
          // ensure response ended, but not strictly required if SDK ends it
          try { res.end(); } catch {}
          return;
        }
        // If returned undefined, assume the SDK has written to the writable stream and will end it.
        if (maybe === undefined) {
          // wait for response finish or a short timeout to assume success
          await new Promise((resolve) => {
            const onFinish = () => { cleanup(); resolve(null); };
            const cleanup = () => { res.removeListener('finish', onFinish); res.removeListener('close', onFinish); };
            res.on('finish', onFinish);
            res.on('close', onFinish);
            setTimeout(() => { cleanup(); resolve(null); }, 30_000);
          });
          try { res.end(); } catch {}
          return;
        }
        // If returned something else, try to handle if it's a readable stream
        if (maybe && typeof maybe.pipe === 'function') {
          maybe.pipe(res);
          await new Promise((resolve, reject) => {
            maybe.on('end', resolve);
            maybe.on('finish', resolve);
            maybe.on('error', reject);
            res.on('close', resolve);
          });
          try { res.end(); } catch {}
          return;
        }
        // otherwise treat as failure for this candidate
        lastErr = new Error('candidate returned unsupported type');
      } else {
        // shape === 'readable-return': function(rootHash) => Readable or Promise<Readable>
        const maybeStream = c.fn(rootHash);
        if (maybeStream && typeof maybeStream.then === 'function') {
          const streamObj = await maybeStream;
          if (streamObj && typeof streamObj.pipe === 'function') {
            streamObj.pipe(res);
            await new Promise((resolve, reject) => {
              streamObj.on('end', resolve);
              streamObj.on('finish', resolve);
              streamObj.on('error', reject);
              res.on('close', resolve);
            });
            try { res.end(); } catch {}
            return;
          }
        } else if (maybeStream && typeof maybeStream.pipe === 'function') {
          maybeStream.pipe(res);
          await new Promise((resolve, reject) => {
            maybeStream.on('end', resolve);
            maybeStream.on('finish', resolve);
            maybeStream.on('error', reject);
            res.on('close', resolve);
          });
          try { res.end(); } catch {}
          return;
        } else {
          lastErr = new Error('candidate did not return a readable stream');
        }
      }
    } catch (err) {
      lastErr = err;
      // try next candidate
    }
  }

  throw lastErr || new Error('all indexer streaming attempts failed');
}

/**
 * streamWhileDownloadingToRes
 *
 * Starts indexer.download(rootHash, tmpFile, false) (which writes to disk), and concurrently
 * reads any new bytes appended to that file and writes them to the HTTP response.
 *
 * This is a pragmatic fallback when the SDK only writes to files. It still writes a temp file
 * but streams to the client immediately and deletes the temp file afterwards.
 */
async function streamWhileDownloadingToRes(rootHash: string, res: Response) {
  const key = safeName(rootHash);
  const tmpFile = path.join(TMP_DIR, key + '.part');

  // remove any leftover partial
  try { await fsp.unlink(tmpFile); } catch {}

  // kick off the download (don't await) — it will write to tmpFile
  const downloadPromise = (async () => {
    const err = await (indexer as any).download(rootHash, tmpFile, false);
    if (err) throw new Error(String(err));
    return true;
  })();

  // We'll open the file descriptor when it appears and stream new bytes
  let fd: any;
  let position = 0;
  let downloadCompleted = false;

  // watch for the downloadPromise completing
  downloadPromise.then(() => { downloadCompleted = true; }).catch(() => { downloadCompleted = true; });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Content-Disposition', `inline; filename="${key}"`);

  // helper to try opening fd if not yet opened
  async function ensureFd() {
    if (fd) return;
    try {
      fd = await fsp.open(tmpFile, 'r');
    } catch (e) {
      // file not created yet
      fd = null;
    }
  }

  // helper to read any new bytes and write to res
  async function pumpOnce() {
    if (!fd) return;
    try {
      const stat = await fd.stat();
      if (stat.size > position) {
        const toRead = stat.size - position;
        const maxChunk = 512 * 1024;
        const readSize = Math.min(toRead, maxChunk);
        const buffer = Buffer.alloc(readSize);
        const { bytesRead } = await fd.read(buffer, 0, readSize, position);
        if (bytesRead && bytesRead > 0) {
          position += bytesRead;
          const ok = res.write(buffer.slice(0, bytesRead));
          if (!ok) {
            // backpressure — wait for drain
            await new Promise((resolve) => res.once('drain', resolve));
          }
        }
      }
    } catch (e) {
      // swallow transient read errors
    }
  }

  // poll loop until download completes and we've consumed final bytes
  try {
    while (true) {
      if (!fd) await ensureFd();
      await pumpOnce();

      if (downloadCompleted) {
        // attempt final read(s) and break
        if (fd) {
            
          await pumpOnce();
        }
        break;
      }
      // if client closed connection, abort
      if ((res as any).writableEnded || (res as any).destroyed) {
        break;
      }
      // sleep a bit
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch (err) {
    console.error('streamWhileDownloadingToRes error:', err);
  } finally {

    try { if (fd) await fd.close(); } catch {}
    try { await fsp.unlink(tmpFile); } catch {}
    try { res.end(); } catch {}
  }
}

// HEAD endpoint — useful for service worker metadata discovery
app.head('/api/v1/storage/:rootHash', async (req: Request, res: Response) => {
  const rootHash = req.params.rootHash;
  if (!isValidRootHash(rootHash)) return res.status(400).json({ error: "Invalid rootHash format" });

  try {
    const filePath = await downloadToTmp(rootHash);
    const stat = await fsp.stat(filePath);
    const encodedCtx: any = await maybeGetOnchainCtx(rootHash);
    const contentType = resolveContentType(filePath, encodedCtx);

    const etag = makeETag(stat);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, If-None-Match, If-Modified-Since');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());

    if (req.headers['if-none-match'] && req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    return res.status(200).end();
  } catch (e) {
    console.error('HEAD failed:', (e as Error).message);
    return res.status(502).end();
  }
});

app.options('/api/v1/storage/:rootHash', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, If-None-Match, If-Modified-Since');
  res.status(204).end();
});

app.get('/api/v1/storage/:rootHash', async (req: Request, res: Response) => {
  const rootHash = req.params.rootHash;
  if (!isValidRootHash(rootHash)) return res.status(400).json({ error: "Invalid rootHash format" });

  const rangeHeader = req.headers.range as string | undefined;
  const wantsHtml = req.headers.accept && req.headers.accept.includes('text/html');

  // If browser wants HTML and this is NOT a range request, serve the demo HTML (inject rootHash)
  if (!rangeHeader && wantsHtml) {
    try {
      const demoPath = path.join(process.cwd(), 'public', 'video-player.html');
      let html = await fsp.readFile(demoPath, 'utf8');
      const injectScript = `<script>window.__OG_ROOT_FROM_SERVER = ${JSON.stringify(rootHash)};</script>`;
      if (html.includes('<!-- INJECT_ROOT_HASH -->')) {
        html = html.replace('<!-- INJECT_ROOT_HASH -->', injectScript);
      } else if (html.includes('</head>')) {
        html = html.replace('</head>', injectScript + '</head>');
      } else {
        html = injectScript + html;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    } catch (e) {
      console.warn('could not load demo HTML, falling back to file streaming', (e as Error).message);
      // continue to normal streaming
    }
  }

  // For non-range requests: try direct indexer streaming (no tmp) -> fallback to streamWhileDownloadingToRes -> fallback to downloadToTmp
  if (!rangeHeader) {
    try {
      await tryDirectStreamFromIndexer(rootHash, res);
      return;
    } catch (err) {
      console.warn('direct indexer streaming failed, falling back to streamWhileDownloadingToRes:', (err as Error).message);
      try {
        await streamWhileDownloadingToRes(rootHash, res);
        return;
      } catch (err2) {
        console.warn('streamWhileDownloadingToRes failed, falling back to disk download:', (err2 as Error).message);
        // continue to disk-backed path below
      }
    }
  }

  // ---- Disk-backed / Range path (unchanged) ----
  const encodedCtx: any = await maybeGetOnchainCtx(rootHash);

  let filePath: string;
  try {
    filePath = await downloadToTmp(rootHash);
  } catch (e) {
    console.error('downloadToTmp failed:', (e as Error).message);
    return res.status(502).send('failed to fetch file from storage');
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (e) {
    return res.status(500).send('file missing');
  }
  const fileSize = stat.size;
  const contentType = resolveContentType(filePath, encodedCtx);
  const etag = makeETag(stat);

  // common headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, If-None-Match, If-Modified-Since');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());

  // conditional GET
  if (req.headers['if-none-match'] && req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  if (rangeHeader) {
    const range = parseRangeHeader(rangeHeader, fileSize);
    if (!range) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
    }
    const { start, end } = range;
    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', String(chunkSize));
    res.setHeader('Content-Type', contentType);

    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
    stream.on('error', (err) => {
      console.error('stream error', err);
      try { res.destroy(); } catch {}
    });
    return;
  }

  // full body (disk-backed fallback)
  res.status(200);
  res.setHeader('Content-Length', String(fileSize));
  res.setHeader('Content-Type', contentType);
  {
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', (err) => {
      console.error('stream error', err);
      try { res.destroy(); } catch {}
    });
  }
});

// existing downloadToTmp (unchanged)
async function downloadToTmp(rootHash: string) {
  const key = safeName(rootHash);
  const cached = cache.get(key);
  if (cached) {
    try {
      await fsp.access(cached.path);
      return cached.path;
    } catch {
      cache.delete(key);
    }
  }

  if (downloadLocks.has(key)) return downloadLocks.get(key)!;
  const p = (async () => {
    const tmpFile = path.join(TMP_DIR, key);
    try { await fsp.unlink(tmpFile); } catch {}
    // indexer.download(rootHash, filePath, proof:boolean) => Promise<Error|null>
    const err = await (indexer as any).download(rootHash, tmpFile, false);
    if (err) {
      try { await fsp.unlink(tmpFile); } catch {}
      throw new Error(`indexer.download failed: ${String(err)}`);
    }
    const stat = await fsp.stat(tmpFile);
    cache.set(key, { path: tmpFile, size: stat.size, addedAt: Date.now() });
    return tmpFile;
  })();

  downloadLocks.set(key, p);
  try {
    const result = await p;
    return result;
  } finally {
    downloadLocks.delete(key);
  }
}

// supports suffix ranges and basic patterns
function parseRangeHeader(rangeHeader: string | undefined, fileSize: number) {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return null;
  const first = m[1];
  const last = m[2];

  if (first === '' && last === '') return null;

  if (first === '') {
    // suffix "-N" => last N bytes
    const suffixLen = parseInt(last, 10);
    if (isNaN(suffixLen) || suffixLen <= 0) return null;
    const start = Math.max(0, fileSize - suffixLen);
    const end = fileSize - 1;
    return { start, end };
  }

  const start = parseInt(first, 10);
  const end = last === '' ? fileSize - 1 : parseInt(last, 10);
  if (isNaN(start) || isNaN(end)) return null;
  if (start > end) return null;
  if (start < 0 || start >= fileSize) return null;
  return { start, end: Math.min(end, fileSize - 1) };
}

// serve the demo page when user visits /<rootHash> (but ignore /api and /cached-files)
app.get('/:maybeRoot', async (req: Request, res: Response, next) => {
  const maybeRoot = req.params.maybeRoot;
  if (!maybeRoot || maybeRoot.startsWith('api') || maybeRoot.startsWith('cached-files') || maybeRoot.endsWith('.js') || maybeRoot.endsWith('.css')) {
    return next();
  }
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(maybeRoot)) {
    const demoPath = path.join(process.cwd(), 'public', 'video-player.html');
    return res.sendFile(demoPath);
  }
  return next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OG stateless gateway listening on :${PORT}`);
  console.log(`TMP_DIR=${TMP_DIR}`);
});
