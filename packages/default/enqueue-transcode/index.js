// packages/default/enqueue-transcode/index.js
import { z } from "zod";
import Redis from "ioredis";
import crypto from "crypto";

const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const ENQUEUE_TOKEN = process.env.ENQUEUE_TOKEN;     // same secret your upload Function uses
const REDIS_URL = process.env.REDIS_URL;             // same Redis as the worker
const JOB_TTL_SEC = Number(process.env.JOB_TTL_SEC || 3 * 24 * 3600);

const redis = new Redis(REDIS_URL, REDIS_URL.startsWith("rediss://") ? { tls: {} } : undefined);

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key, x-enqueue-token",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
    "Vary": "Origin",
    ...extra,
  };
}

const Payload = z.object({
  spaceKey: z.string().min(1),
  originalFilename: z.string().optional(),
  contentType: z.string().optional(),
  outFolder: z.string().default("uploads-shd"),
  reqId: z.string().optional()
});

function statusKey(jobId){ return `transcode:job:${jobId}`; }

async function markQueued(jobId, data){
  const key = statusKey(jobId);
  await redis.hset(key, {
    status: "queued",
    queuedAt: new Date().toISOString(),
    key: data.spaceKey,
    contentType: data.contentType || "",
    outFolder: data.outFolder
  });
  await redis.expire(key, JOB_TTL_SEC);
}

export async function main(event = {}) {
  const method = String(event?.http?.method || event?.__ow_method || "POST").toUpperCase();
  const reqId = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10));

  if (method === "OPTIONS") return { statusCode: 204, headers: cors({ "request-id": reqId }), body: "" };
  if (method !== "POST")   return { statusCode: 405, headers: cors({ "request-id": reqId }), body: JSON.stringify({ ok:false, error:"Method Not Allowed", reqId }) };

  // Auth
  const token = event?.http?.headers?.["x-enqueue-token"] || event?.headers?.["x-enqueue-token"];
  if (!ENQUEUE_TOKEN || token !== ENQUEUE_TOKEN) {
    return { statusCode: 401, headers: cors({ "request-id": reqId }), body: JSON.stringify({ ok:false, error:"Unauthorized", reqId }) };
  }

  // Parse body
  let body = {};
  try {
    if (event && typeof event === "object" && !event.__ow_body) body = event;
    else if (event?.__ow_body) {
      const text = event.__ow_isBase64 ? Buffer.from(event.__ow_body, "base64").toString("utf8") : event.__ow_body;
      body = text ? JSON.parse(text) : {};
    }
  } catch {
    return { statusCode: 400, headers: cors({ "request-id": reqId }), body: JSON.stringify({ ok:false, error:"Invalid JSON", reqId }) };
  }

  const parsed = Payload.safeParse(body);
  if (!parsed.success) {
    return { statusCode: 422, headers: cors({ "request-id": reqId }), body: JSON.stringify({ ok:false, error:"Invalid payload", details: parsed.error.flatten(), reqId }) };
  }
  const payload = parsed.data;

  // Idempotency (optional): dedupe per key if header provided
  const idemKey = event?.http?.headers?.["idempotency-key"] || event?.headers?.["idempotency-key"];
  if (idemKey) {
    const idemRedisKey = `transcode:idem:${idemKey}`;
    const existing = await redis.get(idemRedisKey);
    if (existing) {
      const { jobId } = JSON.parse(existing);
      return { statusCode: 200, headers: cors({ "request-id": reqId }), body: JSON.stringify({ ok:true, jobId, reqId, deduped:true }) };
    }
  }

  // Create and queue job
  const jobId = crypto.randomUUID();
  const job = { id: jobId, key: payload.spaceKey };
  await markQueued(jobId, payload);
  await redis.lpush("transcode:queue", JSON.stringify(job));

  if (idemKey) {
    await redis.set(`transcode:idem:${idemKey}`, JSON.stringify({ jobId }), "EX", JOB_TTL_SEC);
  }

  return { statusCode: 200, headers: cors({ "request-id": reqId }), body: JSON.stringify({ ok:true, jobId, reqId }) };
}
