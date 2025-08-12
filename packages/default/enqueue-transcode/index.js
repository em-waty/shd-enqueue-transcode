import { z } from "zod";

const {
  ENQUEUE_API_URL,
  ENQUEUE_TOKEN,
  CORS_ORIGIN = "*",
} = process.env;

const JobSchema = z.object({
  spaceKey: z.string().min(1),
  originalFilename: z.string().optional(),
  contentType: z.string().optional(),
  outFolder: z.string().default("uploads-shd"),
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

export async function main(args = {}) {
  const method = ((args.__ow_method ?? "GET") + "").toUpperCase();
  if (method === "OPTIONS") return { statusCode: 204, headers: cors(), body: "" };
  if (method === "GET") return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, service: "enqueue-transcode", time: new Date().toISOString() }) };
  if (method !== "POST") return { statusCode: 405, headers: cors(), body: JSON.stringify({ ok: false, error: "Method Not Allowed" }) };

  if (!ENQUEUE_API_URL || !ENQUEUE_TOKEN) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ ok: false, error: "Missing ENQUEUE_API_URL or ENQUEUE_TOKEN" }) };
  }

  // Parse DO web-action args (query/JSON)
  let json = {};
  try {
    if (args && typeof args === "object" && !args.__ow_body) {
      const { __ow_method, __ow_headers, __ow_path, __ow_isBase64, __ow_query, ...rest } = args;
      json = rest;
    } else if (args?.__ow_body) {
      const raw = args.__ow_body;
      const text = args.__ow_isBase64 ? Buffer.from(raw, "base64").toString("utf8") : raw;
      json = text ? JSON.parse(text) : {};
    }
  } catch {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ ok: false, error: "Invalid JSON body" }) };
  }

  const parsed = JobSchema.safeParse(json);
  if (!parsed.success) {
    return { statusCode: 422, headers: cors(), body: JSON.stringify({ ok: false, error: "Invalid payload", details: parsed.error.flatten() }) };
  }

  try {
    const resp = await fetch(ENQUEUE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-enqueue-token": ENQUEUE_TOKEN },
      body: JSON.stringify(parsed.data),
    });
    const text = await resp.text(); // pass-through
    return { statusCode: resp.status, headers: cors(), body: text };
  } catch (err) {
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ ok: false, error: "Gateway error", details: String(err?.message || err) }) };
  }
}
