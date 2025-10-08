/**
 * src/gateway.ts
 *
 * Minimal stateless HTTP gateway for OG storage (TypeScript).
 * - Streams files to browser
 * - Supports Range requests (video/audio seeking)
 * - Uses on-chain OGFileCtx to set Content-Type when available
 * - Uses Indexer.download(rootHash, path, proof) to fetch files
 * - Caches downloaded files on disk with simple LRU eviction
 *
 * Run in dev:
 *   npm run dev
 *
 * Build + run:
 *   npm run build
 *   npm start
 */
// test rootHash=0xda5255f73287096e526638ea0ebc036c5a52d5fbd73c56a20e795e78e7a22735

import express, { Request, Response } from 'express'
import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import { ethers } from "ethers"
import { NETWORKS } from '@searchboxlabs/metalayer/dist/network';
import MetaLayerClient from '@searchboxlabs/metalayer';
import { LRUCache } from 'lru-cache';
import fsp from 'fs/promises';
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
const indexer = new Indexer(NETWORKS.testnet.indexerUrl)

type DownloadPromise = Promise<string>; // resolves to filepath
const downloadLocks = new Map<string, DownloadPromise>(); // dedupe concurrent downloads

// ---------- in-memory helpers ----------
(async () => {
    await fsp.mkdir(TMP_DIR, { recursive: true });
})();


// simple LRU for disk-cached files (stores metadata only)
const cache = new LRUCache<string, { path: string; size: number; addedAt: number }>({
  max: CACHE_MAX_ENTRIES,
  ttl: CACHE_MAX_AGE_MS,
  dispose: async (value, key) => {
    // delete file on eviction
    try {
      await fsp.unlink(value.path);
    } catch (e) {
      // ignore
    }
  },
});

app.get('/api/v1/storage/:rootHash', async (req: Request, res: Response) => {
    const rootHash = req.params.rootHash;

    // Validate the rootHash format
    if (
      typeof rootHash !== "string" ||
      !rootHash.startsWith("0x") ||
      rootHash.length !== 66 || // 0x + 64 hex chars (32 bytes)
      !/^0x[0-9a-fA-F]+$/.test(rootHash)
    ) {
      return res.status(400).json({ error: "Invalid rootHash format" });
    }
    const provider = new ethers.JsonRpcProvider(NETWORKS.testnet.rpcUrl);
    const signer = new ethers.Wallet(rootHash, provider);
    const encodedCtx: any = await client.getOnchainAwareCtx(rootHash, NETWORKS.testnet, signer)
    
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

    let contentType: any = "text/plain";
    if (!contentType && encodedCtx?.extension) contentType = mime.getType(encodedCtx.extension) || undefined;
    if (!contentType) {
        const ext = path.extname(filePath);
        contentType = mime.getType(ext) || 'application/octet-stream';
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');

    res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
    res.setHeader('Accept-Ranges', 'bytes');

    const rangeHeader = req.headers.range as string | undefined;
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
        res.destroy();
        });
        return;
    }

    res.status(200);
    res.setHeader('Content-Length', String(fileSize));
    res.setHeader('Content-Type', contentType);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', (err) => {
        console.error('stream error', err);
        res.destroy();
    });
})

function safeName(rootHash: string) {
  return rootHash.startsWith('0x') ? rootHash.slice(2) : rootHash;
}

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

    // If another request is downloading, wait on that promise
    if (downloadLocks.has(key)) return downloadLocks.get(key)!;
    const p = (async () => {
        const tmpFile = path.join(TMP_DIR, key);
        // delete partial file if present
        try { await fsp.unlink(tmpFile); } catch {}
        // indexer.download(rootHash, filePath, proof:boolean) => Promise<Error|null>
        const err = await indexer.download(rootHash, tmpFile, false);
        if (err) {
        // cleanup if error
        try { await fsp.unlink(tmpFile); } catch {}
        throw new Error(`indexer.download failed: ${String(err)}`);
        }
        const stat = await fsp.stat(tmpFile);
        // add to cache meta
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

function parseRangeHeader(rangeHeader: string | undefined, fileSize: number) {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!m) return null;
  const start = m[1] === '' ? null : parseInt(m[1], 10);
  const end = m[2] === '' ? null : parseInt(m[2], 10);
  const s = start ?? 0;
  const e = end ?? fileSize - 1;
  if (s > e || e < 0 || s >= fileSize) return null;
  return { start: s, end: Math.min(e, fileSize - 1) };
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`OG stateless gateway listening on :${PORT}`);
    console.log(`TMP_DIR=${TMP_DIR}`)
})