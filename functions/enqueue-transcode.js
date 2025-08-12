// DigitalOcean Functions (Node 18+) - Web action
// Purpose: accept POST JSON and enqueue a job for the droplet worker via Redis.

import Redis from "ioredis";
import { z } from "zod";
import { randomUUID } from "crypto";

const {
  REDIS_URL,
  QUEUE_KEY = "shd:transcode:jobs",
  CORS_ORIGIN = "*",
} = process.env;

// Validate incoming payload
const JobSchema = z.object({
  spaceKey: z.string().min(1),            // e.g. "uploads/2025-08-11_video.mp4"
  originalFilename: z.string().optional(),
  contentType: z.string().optional(),     // e.g. "video/mp4"
  outFolder: z.string().default("uploads-shd")
});

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
    ...extra,
  };
}

export async function main(args) {
  const method = (args.__ow_method || "GET").toUpperCase();

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }

  if (method === "GET") {
    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({ ok: true, service: "enqueue-transcode", time: new Date().toISOString() }),
    };
  }

  if (method !== "POST") {
    return { statusCode: 405, headers: cors(), body: JSON.stringify({ ok: false, error: "Method Not Allowed" }) };
  }

  if (!REDIS_URL) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ ok: false, error: "Missing REDIS_URL env" }) };
  }

  // Parse body
  let json = {};
  try {
    const raw = args.__ow_body || "";
    json = raw ? JSON.parse(raw) : {};
  } catch {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ ok: false, error: "Invalid JSON body" }) };
  }

  // Validate
  const parsed = JobSchema.safeParse(json);
  if (!parsed.success) {
    return {
      statusCode: 422,
      headers: cors(),
      body: JSON.stringify({ ok: false, error: "Invalid payload", details: parsed.error.flatten() }),
    };
  }

  const jobId = randomUUID();
  const job = {
    jobId,
    type: "transcode",
    createdAt: new Date().toISOString(),
    ...parsed.data,
  };

  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    tls: REDIS_URL.startsWith("rediss://") ? {} : undefined,
  });

  try {
    await redis.connect();
    await redis.lpush(QUEUE_KEY, JSON.stringify(job));
    await redis.quit();

    return { statusCode: 201, headers: cors(), body: JSON.stringify({ ok: true, jobId }) };
  } catch (err) {
    try { await redis.quit(); } catch {}
    return {
      statusCode: 500,
      headers: cors(),
      body: JSON.stringify({ ok: false, error: "Enqueue failed", details: String(err?.message || err) }),
    };
  }
}
