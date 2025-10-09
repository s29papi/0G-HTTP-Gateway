
---

# 🧠 Technical Delivery — OG Gateway (Built on MetaLayer)

Demo:

 [![Watch on YouTube](https://img.youtube.com/vi/xb2ljnOQZ-Y/0.jpg)](https://youtu.be/xb2ljnOQZ-Y)


## Overview

The **OG Gateway** is a **stateless HTTP bridge** for the **OG Storage Network**, enabling **direct in-browser access** to on-chain, content-addressed data — without requiring users to download files or run an OG node.

This project was built on **MetaLayer**, leveraging its on-chain context and network SDKs to resolve file metadata and Content-Type directly from OGFileCtx.

By combining the **MetaLayer client**, **0G Indexer**, and an **Express-based streaming server**, we implemented a fully operational gateway that serves OG content over standard HTTP semantics — supporting range requests, caching, and inline rendering.

---

## ⚙️ Core Accomplishments

* **Built on MetaLayer:**
  Uses `@searchboxlabs/metalayer` to fetch on-chain file context (`getOnchainAwareCtx`), enabling dynamic detection of MIME types and file extensions.

* **Fully Stateless Gateway:**
  The gateway does not maintain persistent state; all responses are streamed and cached on-demand from OG’s distributed storage layer.

* **Streaming + Range Requests:**
  Implements HTTP Range support, allowing smooth **video/audio seeking** and partial content delivery (e.g., `206 Partial Content`).

* **Disk Caching with LRU Eviction:**
  Integrates an **LRU cache** to temporarily store recently accessed files on disk, automatically deleting least-used files after expiry.

* **Concurrency-Safe Downloads:**
  Uses a lightweight locking map (`downloadLocks`) to **deduplicate concurrent downloads** of the same CID/rootHash, improving efficiency.

* **Automatic MIME Detection:**
  Uses `mime` and on-chain metadata to determine `Content-Type`, ensuring proper inline rendering in browsers.

* **CORS + Inline Rendering:**
  Enables cross-origin access and sets `Content-Disposition: inline`, allowing **direct browser playback or display** instead of forced downloads.

* **Simple Deployment:**
  Runs as a single Node.js service — deployable on any VPS, container, or serverless function.

---

## 🧩 Design Decisions

| Component            | Role                             | Reasoning                                          |
| -------------------- | -------------------------------- | -------------------------------------------------- |
| **MetaLayer Client** | Fetch on-chain OG file context   | Reliable way to derive file type and metadata      |
| **0G Indexer**       | Fetch file data via content hash | Decentralized and verifiable data retrieval        |
| **Express.js**       | Lightweight HTTP interface       | Familiar, flexible, and scalable                   |
| **LRU Disk Cache**   | Temporary local file storage     | Improves repeat access latency without state bloat |
| **Range Support**    | Handles partial requests         | Enables seamless media streaming                   |
| **Stateless Design** | No persistent DB                 | Simpler scaling and easier reliability             |

---

## 🧠 How It Works

```
Browser → OG Gateway → MetaLayer (on-chain ctx)
                      ↳ 0G Indexer → OG Storage Nodes
```

1. **Request:**
   The browser requests `GET /api/v1/storage/:rootHash`.

2. **Resolve Context:**
   The gateway queries MetaLayer for file metadata (e.g., MIME type, extension).

3. **Fetch Data:**
   The Indexer downloads the file from OG Storage into a temporary cache.

4. **Stream Response:**
   The gateway streams the file back to the client with correct headers.

5. **Evict Old Files:**
   Cached files are automatically deleted after TTL or capacity overflow.

---

## 💻 Example Usage

```bash
curl http://localhost:3000/api/v1/storage/0xda5255f73287096e526638ea0ebc036c5a52d5fbd73c56a20e795e78e7a22735
```

or open directly in a browser:

```
http://localhost:3000/api/v1/storage/0xda5255f73287096e526638ea0ebc036c5a52d5fbd73c56a20e795e78e7a22735
```

---

## 🏁 Outcome

The **OG Gateway** demonstrates how decentralized storage on OG can be made **directly accessible from any web browser**, using standard HTTP without downloads or custom clients.

By translating **content-addressed data** into **web-native streams**, it bridges the gap between decentralized storage and traditional web access — enabling seamless in-browser rendering, media playback, and integration with existing web apps.

The gateway is **lightweight, stateless, and verifiable**, designed for real-world scalability. It serves as a foundation for a future where **OG-powered content** can be accessed as easily as any HTTP resource — a true **OG → Web bridge** for decentralized data.

---
