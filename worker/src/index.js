/**
 * Housepainter — temporary image hosting worker
 *
 * Endpoints:
 *   POST /upload  → store image in R2, return short-lived URL
 *   GET  /:key    → serve image, delete after MAX_FETCHES
 *   GET  /status  → show current usage counters (for debugging)
 *   Cron (hourly) → purge expired images, update storage-byte counter
 *
 * R2 operation accounting (free tier: 1M Class A, 10M Class B, 10 GB-month):
 *   Upload:    1× R2 put  (Class A)          — fetch count tracked in KV, NOT a re-put
 *   GET fetch: 1× R2 get  (Class B)
 *              then either 1× R2 delete (Class A) on last fetch, or nothing
 *   Cron:      1× R2 list (Class A, paginated) + N× R2 delete (Class A, batched)
 *   Rate limit: 0 R2 ops  — done entirely in KV
 *   Fetch count: 0 R2 ops — done entirely in KV
 *
 * KV operation accounting (free tier: 100K reads/day, 1K writes/day):
 *   Upload:    1 KV read  (rate limit check) + 1 KV write (increment RL counter)
 *              + 1 KV write (init fetch counter, TTL=MAX_AGE_SECONDS)
 *              + 1 KV write (increment usage stats)
 *   GET fetch: 1 KV read  (fetch counter) + 1 KV write (increment/delete counter)
 *              + 1 KV write (increment usage stats)
 *   Cron:      1 KV read  (usage stats) + 1 KV write (update storage bytes)
 *   Circuit breaker check: 1 KV read per request (cached in-memory per isolate)
 *
 * KV keys:
 *   rl:{ip}           → upload count for this IP this hour  (TTL: 3600s)
 *   fc:{r2key}        → fetch count for this image          (TTL: MAX_AGE_SECONDS)
 *   usage:{YYYY-MM}   → JSON { storageBytes, classAOps, classBOps } for the current month
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim());
  const isAllowed =
    allowed.includes(origin) ||
    /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : allowed[0] || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function randomKey() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Current month key: "usage:2026-03" */
function monthKey() {
  return "usage:" + new Date().toISOString().slice(0, 7);
}

// ─── KV-backed usage tracking ────────────────────────────────────────────────

/** Read the current month's usage stats from KV (1 KV read). */
async function getUsage(env) {
  const raw = await env.KV.get(monthKey());
  if (!raw) return { storageBytes: 0, classAOps: 0, classBOps: 0 };
  try {
    return JSON.parse(raw);
  } catch {
    return { storageBytes: 0, classAOps: 0, classBOps: 0 };
  }
}

/**
 * Increment one or more usage counters in KV (1 KV read + 1 KV write).
 * @param {object} delta  e.g. { classAOps: 1 } or { classBOps: 1, classAOps: 1 }
 */
async function bumpUsage(env, delta) {
  const key = monthKey();
  const cur = await getUsage(env);
  const next = {
    storageBytes: (cur.storageBytes || 0) + (delta.storageBytes || 0),
    classAOps: (cur.classAOps || 0) + (delta.classAOps || 0),
    classBOps: (cur.classBOps || 0) + (delta.classBOps || 0),
  };
  // Store for 40 days so it covers month boundaries with some overlap
  await env.KV.put(key, JSON.stringify(next), { expirationTtl: 40 * 86400 });
  return next;
}

// ─── Circuit breaker ─────────────────────────────────────────────────────────

// Cache the circuit-breaker decision in-memory for 60 s to avoid a KV read on
// every single request (Workers isolates are reused frequently).
let cbCache = { tripped: false, checkedAt: 0 };

/**
 * Returns true if any usage counter has exceeded its configured threshold.
 * Reads KV at most once per 60 seconds per isolate instance.
 */
async function isCircuitTripped(env) {
  const now = Date.now();
  if (now - cbCache.checkedAt < 60_000) return cbCache.tripped;

  const usage = await getUsage(env);
  const tripped =
    usage.storageBytes >= parseInt(env.CB_STORAGE_BYTES || "8589934592") ||
    usage.classAOps >= parseInt(env.CB_CLASS_A_OPS || "800000") ||
    usage.classBOps >= parseInt(env.CB_CLASS_B_OPS || "8000000");

  cbCache = { tripped, checkedAt: now };
  return tripped;
}

// ─── IP rate limiting (KV) ───────────────────────────────────────────────────

/**
 * Increment the per-IP upload counter and return the new count.
 * Key TTL is 3600 s so it naturally resets each hour (1 KV read + 1 KV write).
 */
async function incrementRateLimit(env, ip) {
  const key = `rl:${ip}`;
  const cur = parseInt((await env.KV.get(key)) || "0");
  const next = cur + 1;
  await env.KV.put(key, String(next), { expirationTtl: 3600 });
  return next;
}

// ─── Upload handler ──────────────────────────────────────────────────────────

async function handleUpload(request, env) {
  // 1. Circuit breaker
  if (await isCircuitTripped(env)) {
    return json(
      { error: "Service temporarily unavailable (capacity limit reached)" },
      503,
    );
  }

  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown";

  // 2. Fast content-length check before reading body
  const maxBytes = parseInt(env.MAX_UPLOAD_BYTES || "5242880");
  const contentLength = parseInt(request.headers.get("Content-Length") || "0");
  if (contentLength > maxBytes) {
    return json({ error: `File too large (max ${maxBytes / 1048576} MB)` }, 413);
  }

  // 3. IP rate limit (KV read + write)
  const rateLimitPerHour = parseInt(env.RATE_LIMIT_PER_HOUR || "5");
  const uploadCount = await incrementRateLimit(env, ip);
  if (uploadCount > rateLimitPerHour) {
    // Decrement back so we don't inflate the counter past the limit forever
    await env.KV.put(`rl:${ip}`, String(uploadCount - 1), {
      expirationTtl: 3600,
    });
    return json(
      {
        error: `Rate limit exceeded: max ${rateLimitPerHour} uploads per hour per IP`,
      },
      429,
    );
  }

  // 4. Parse and validate the uploaded file
  let file;
  try {
    const formData = await request.formData();
    file = formData.get("image");
  } catch {
    return json({ error: "Invalid form data" }, 400);
  }

  if (!file || typeof file === "string") {
    return json({ error: "No image file provided (field name: image)" }, 400);
  }

  const contentType = file.type || "";
  if (!contentType.startsWith("image/")) {
    return json({ error: "Only image/* files are accepted" }, 400);
  }

  // 5. Read body and enforce actual byte size
  const arrayBuffer = await file.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    return json({ error: `File too large (max ${maxBytes / 1048576} MB)` }, 413);
  }

  const key = randomKey();
  const maxFetches = parseInt(env.MAX_FETCHES || "3");
  const maxAgeSeconds = parseInt(env.MAX_AGE_SECONDS || "3600");

  // 6. Store image in R2 (1× Class A put)
  await env.IMAGES.put(key, arrayBuffer, {
    httpMetadata: { contentType },
    customMetadata: {
      ip,
      uploadedAt: Date.now().toString(),
      sizeBytes: arrayBuffer.byteLength.toString(),
      contentType,
    },
  });

  // 7. Store fetch counter in KV — avoids re-putting the full image on every GET
  //    (1× KV write, TTL = max age so it auto-expires)
  await env.KV.put(`fc:${key}`, "0", { expirationTtl: maxAgeSeconds });

  // 8. Update usage stats: +1 Class A op, +N bytes stored
  //    We do this fire-and-forget (don't await) to not slow down the response
  bumpUsage(env, {
    classAOps: 1,
    storageBytes: arrayBuffer.byteLength,
  });

  const origin = new URL(request.url).origin;
  return json({
    url: `${origin}/${key}`,
    key,
    expiresAfterFetches: maxFetches,
    expiresInSeconds: maxAgeSeconds,
  });
}

// ─── Fetch/serve handler ─────────────────────────────────────────────────────

async function handleGet(request, env, key) {
  // Validate key looks like our 16-char hex
  if (!/^[0-9a-f]{16}$/.test(key)) {
    return new Response("Not found", { status: 404 });
  }

  // 1. Check and increment fetch counter in KV (1 read + 1 write, or 1 read + delete)
  const fcKey = `fc:${key}`;
  const maxFetches = parseInt(env.MAX_FETCHES || "3");
  const rawCount = await env.KV.get(fcKey);

  // If KV entry is gone but R2 object somehow still exists, treat as expired
  if (rawCount === null) {
    // Attempt cleanup of any orphaned R2 object (best-effort, don't fail if absent)
    env.IMAGES.delete(key).catch(() => {});
    return new Response("Not found or expired", { status: 404 });
  }

  const fetchCount = parseInt(rawCount) + 1;
  const isLastFetch = fetchCount >= maxFetches;

  // 2. Fetch image from R2 (1× Class B get)
  const obj = await env.IMAGES.get(key);
  if (!obj) {
    // R2 object missing — clean up stale KV entry
    await env.KV.delete(fcKey);
    return new Response("Not found", { status: 404 });
  }

  const meta = obj.customMetadata || {};
  const contentType =
    meta.contentType || obj.httpMetadata?.contentType || "image/jpeg";
  const sizeBytes = parseInt(meta.sizeBytes || "0");

  // 3. Read body
  const body = await obj.arrayBuffer();

  // 4. Update counters (fire-and-forget to not delay the response)
  if (isLastFetch) {
    // Delete KV entry and R2 object (1× Class A delete)
    Promise.all([
      env.KV.delete(fcKey),
      env.IMAGES.delete(key),
    ]).catch(console.error);
    bumpUsage(env, {
      classAOps: 1,           // delete
      classBOps: 1,           // get
      storageBytes: -sizeBytes, // freed
    });
  } else {
    // Update KV fetch counter, no R2 write needed
    env.KV.put(fcKey, String(fetchCount), {
      expirationTtl: parseInt(env.MAX_AGE_SECONDS || "3600"),
    }).catch(console.error);
    bumpUsage(env, { classBOps: 1 });
  }

  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
  });
}

// ─── Status endpoint ─────────────────────────────────────────────────────────

async function handleStatus(env) {
  const usage = await getUsage(env);
  const tripped = await isCircuitTripped(env);
  return json({
    month: monthKey().replace("usage:", ""),
    tripped,
    usage,
    thresholds: {
      storageBytes: parseInt(env.CB_STORAGE_BYTES || "8589934592"),
      classAOps: parseInt(env.CB_CLASS_A_OPS || "800000"),
      classBOps: parseInt(env.CB_CLASS_B_OPS || "8000000"),
    },
    freetier: {
      storageBytesPerMonth: 10 * 1024 * 1024 * 1024,
      classAOpsPerMonth: 1_000_000,
      classBOpsPerMonth: 10_000_000,
    },
  });
}

// ─── Cron: sweep expired images + recount storage bytes ──────────────────────

async function handleCron(env) {
  const maxAgeMs = parseInt(env.MAX_AGE_SECONDS || "3600") * 1000;
  const cutoff = Date.now() - maxAgeMs;

  const toDelete = [];
  let storageBytesInUse = 0;
  let cursor;

  // R2 list is 1 Class A op per page (up to 1000 objects per page)
  do {
    const listed = await env.IMAGES.list({ cursor, limit: 1000 });
    await bumpUsage(env, { classAOps: 1 }); // count this list page

    for (const obj of listed.objects) {
      const m = obj.customMetadata || {};
      const uploadedAt = parseInt(m.uploadedAt || "0");
      const sizeBytes = parseInt(m.sizeBytes || "0");

      if (uploadedAt < cutoff) {
        toDelete.push(obj.key);
      } else {
        storageBytesInUse += sizeBytes;
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // Batch-delete expired objects (each batch of ≤1000 = 1 Class A op)
  for (let i = 0; i < toDelete.length; i += 1000) {
    const batch = toDelete.slice(i, i + 1000);
    await env.IMAGES.delete(batch);
    await bumpUsage(env, { classAOps: 1, storageBytes: 0 }); // delete is Class A
  }

  // Also clean up any KV fetch-counter entries whose R2 object was just deleted
  // (they'd auto-expire anyway via TTL, so this is just housekeeping)
  for (const key of toDelete) {
    env.KV.delete(`fc:${key}`).catch(() => {});
  }

  // Recalibrate the storage counter with the actual measured value
  // (overrides the accumulated delta which can drift)
  const cur = await getUsage(env);
  const corrected = { ...cur, storageBytes: storageBytesInUse };
  await env.KV.put(monthKey(), JSON.stringify(corrected), {
    expirationTtl: 40 * 86400,
  });

  // Invalidate in-memory circuit breaker cache so next request re-checks
  cbCache = { tripped: false, checkedAt: 0 };

  console.log(
    `Cron: deleted ${toDelete.length} expired images; ` +
      `${(storageBytesInUse / 1048576).toFixed(1)} MB in use`,
  );
  return toDelete.length;
}

// ─── Main fetch handler ──────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const path = new URL(request.url).pathname.replace(/^\/+/, "");

    let response;
    try {
      if (request.method === "POST" && path === "upload") {
        response = await handleUpload(request, env);
      } else if (request.method === "GET" && path === "status") {
        response = await handleStatus(env);
      } else if (request.method === "GET" && path) {
        response = await handleGet(request, env, path);
      } else {
        response = json({ error: "Not found" }, 404);
      }
    } catch (err) {
      console.error("Worker error:", err);
      response = json({ error: "Internal server error" }, 500);
    }

    // Attach CORS headers to every response
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  },

  async scheduled(_event, env) {
    await handleCron(env);
  },
};
