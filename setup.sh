#!/bin/bash
set -e

echo "=== Setting up shd-enqueue-transcode project ==="

# Go to project folder
cd "$(dirname "$0")"

# 1) Init Node + Git
echo "--- Initializing Node.js and Git ---"
npm init -y
git init || true

# 2) Create structure
mkdir -p functions

# 3) .gitignore
cat > .gitignore <<'EOF'
node_modules
.env
.DS_Store
EOF

# 4) Example env file
cat > .env.example <<'EOF'
# Required
REDIS_URL=rediss://<user>:<pass>@<host>:<port>

# Optional
QUEUE_KEY=shd:transcode:jobs
CORS_ORIGIN=*
EOF

cp .env.example .env

# 5) package.json
cat > package.json <<'EOF'
{
  "name": "shd-enqueue-transcode",
  "version": "1.0.0",
  "type": "module",
  "main": "functions/enqueue-transcode.js",
  "scripts": {
    "lint": "node -e \"process.exit(0)\"",
    "deploy": "doctl serverless deploy .",
    "undeploy": "doctl serverless undeploy .",
    "print": "doctl serverless activations get --last"
  },
  "dependencies": {
    "ioredis": "^5.4.1",
    "uuid": "^9.0.1",
    "zod": "^3.23.8"
  }
}
EOF

# 6) Install dependencies
echo "--- Installing dependencies ---"
npm install

# 7) Function code
cat > functions/enqueue-transcode.js <<'EOF'
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
EOF

# 8) DO Functions manifest
cat > project.yml <<'EOF'
packages:
  - name: default
    actions:
      - name: enqueue-transcode
        runtime: nodejs:18
        web: true
        main: main
        limits:
          timeout: 60000
        environment:
          QUEUE_KEY: ${QUEUE_KEY}
          CORS_ORIGIN: ${CORS_ORIGIN}
          REDIS_URL: ${REDIS_URL}
        source: functions/enqueue-transcode.js
EOF

# 9) README
cat > README.md <<'EOF'
# shd-enqueue-transcode

DigitalOcean Functions “web” action to enqueue transcode jobs into Redis for the droplet worker.

## Deploy
doctl serverless connect
export $(cat .env | xargs) && npm run deploy

## Invoke
# Health
curl -i "https://<YOUR-ENDPOINT>/default/enqueue-transcode"

# Enqueue
curl -i -X POST "https://<YOUR-ENDPOINT>/default/enqueue-transcode" \
  -H "Content-Type: application/json" \
  -d '{"spaceKey":"uploads/test.mp4","originalFilename":"test.mp4","contentType":"video/mp4"}'
EOF

# 10) Initial Git commit
git add -A
git commit -m "Scaffold enqueue-transcode DO Function"

echo "=== Setup complete. Now edit .env and run: doctl serverless connect && export \$(cat .env | xargs) && npm run deploy ==="
