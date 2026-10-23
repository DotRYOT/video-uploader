import {
  MAX_POSTER_BYTES,
  MAX_UPLOAD_BYTES,
  SESSION_SECONDS,
  TIERS,
  VIDEO_TYPES,
  type TierId,
} from "./config";

interface Env {
  ASSETS: Fetcher;
  VIDEOS_BUCKET: R2Bucket;
  VIDEO_REGISTRY: DurableObjectNamespace<VideoRegistry>;
  UPLOAD_PASSWORD: string;
  SESSION_SECRET: string;
  PUBLIC_ORIGIN?: string;
}

interface VideoRecord {
  id: string;
  tier: TierId;
  title: string;
  description: string;
  contentType: string;
  size: number;
  createdAt: number;
  expiresAt: number;
  reservationExpiresAt: number;
  status: "pending" | "active";
  hasPoster: boolean;
}

const encoder = new TextEncoder();
const COOKIE_NAME = "video_drop_session";
const RESERVATION_SECONDS = 2 * 60 * 60;

function json(data: unknown, status = 200, headers = new Headers()): Response {
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

function secureHtml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; media-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

function registry(env: Env): DurableObjectStub<VideoRegistry> {
  return env.VIDEO_REGISTRY.getByName("video-drop");
}

async function registryFetch<T>(
  env: Env,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await registry(env).fetch(`https://registry.internal${path}`, init);
  if (!response.ok) throw new Error(`Registry request failed (${response.status})`);
  return (await response.json()) as T;
}

async function signSession(expiry: number, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(expiry)));
  const encoded = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${expiry}.${encoded}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function hasSession(request: Request, secret: string): Promise<boolean> {
  const cookie = request.headers.get("Cookie") ?? "";
  const value = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  if (!value) return false;

  const [expiryValue, signature] = value.split(".");
  const expiry = Number(expiryValue);
  if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000) || !signature) {
    return false;
  }

  const expected = await signSession(expiry, secret);
  return constantTimeEqual(value, expected);
}

function sameOrigin(request: Request, publicOrigin?: string): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null && (request.method === "GET" || request.method === "HEAD")) return true;
  try {
    const expectedOrigin = publicOrigin ? new URL(publicOrigin).origin : new URL(request.url).origin;
    return origin === expectedOrigin;
  } catch {
    return false;
  }
}

function parseRange(value: string, size: number): { offset: number; length: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || size === 0) return null;

  let offset: number;
  let end: number;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!suffixLength) return null;
    offset = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    offset = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(offset) || offset >= size || end < offset) return null;
  return { offset, length: end - offset + 1, end };
}

async function serveMedia(request: Request, env: Env, id: string): Promise<Response> {
  const video = await registryFetch<VideoRecord | null>(env, `/video/${id}`);
  if (!video || video.status !== "active") return new Response("Not found", { status: 404 });

  const rangeHeader = request.headers.get("Range");
  const range = rangeHeader ? parseRange(rangeHeader, video.size) : null;
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${video.size}`, "Accept-Ranges": "bytes" },
    });
  }

  const object = await env.VIDEOS_BUCKET.get(
    `videos/${id}`,
    range ? { range: { offset: range.offset, length: range.length } } : undefined,
  );
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", video.contentType);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("Content-Length", String(range?.length ?? video.size));
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.end}/${video.size}`);
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

async function servePoster(env: Env, id: string): Promise<Response> {
  const video = await registryFetch<VideoRecord | null>(env, `/video/${id}`);
  if (!video || video.status !== "active" || !video.hasPoster) {
    return new Response("Not found", { status: 404 });
  }
  const poster = await env.VIDEOS_BUCKET.get(`posters/${id}.jpg`);
  if (!poster) return new Response("Not found", { status: 404 });
  return new Response(poster.body, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(poster.size),
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function sharePage(video: VideoRecord, url: URL): Response {
  const title = escapeHtml(video.title);
  const description = escapeHtml(video.description || "A private video shared with you.");
  const pageUrl = `${url.origin}/v/${video.id}`;
  const mediaUrl = `${url.origin}/media/${video.id}`;
  const posterUrl = `${url.origin}/poster/${video.id}`;
  const posterMeta = video.hasPoster
    ? `<meta property="og:image" content="${posterUrl}"><meta property="og:image:type" content="image/jpeg"><meta name="twitter:image" content="${posterUrl}">`
    : "";
  const posterAttribute = video.hasPoster ? ` poster="${posterUrl}"` : "";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${description}">
  <meta property="og:type" content="video.other">
  <meta property="og:site_name" content="Video Drop">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:video" content="${mediaUrl}">
  <meta property="og:video:secure_url" content="${mediaUrl}">
  <meta property="og:video:type" content="${escapeHtml(video.contentType)}">
  <meta name="twitter:card" content="player">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:player" content="${pageUrl}">
  <meta name="twitter:player:width" content="1280">
  <meta name="twitter:player:height" content="720">
  ${posterMeta}
  <title>${title} · Video Drop</title>
  <link rel="stylesheet" href="/share.css">
</head>
<body>
  <main class="watch">
    <a class="wordmark" href="/">VIDEO DROP <span>↗</span></a>
    <p class="eyebrow">SHARED VIDEO · EXPIRES ${new Date(video.expiresAt).toLocaleDateString("en", { dateStyle: "medium", timeZone: "UTC" }).toUpperCase()} UTC</p>
    <h1>${title}</h1>
    ${video.description ? `<p class="description">${description}</p>` : ""}
    <video controls playsinline preload="metadata"${posterAttribute}>
      <source src="/media/${video.id}" type="${escapeHtml(video.contentType)}">
      Your browser does not support this video format.
    </video>
    <p class="expiry">This link is temporary. It will be removed after its expiry date.</p>
  </main>
</body>
</html>`;
  return secureHtml(html);
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/config" && request.method === "GET") {
    const state = await registryFetch<{ videos: VideoRecord[]; pending: VideoRecord[] }>(env, "/state");
    return json({
      maxUploadBytes: MAX_UPLOAD_BYTES,
      tiers: Object.entries(TIERS).map(([id, tier]) => {
        const used = [...state.videos, ...state.pending].filter((video) => video.tier === id).length;
        return { id, ...tier, used, available: Math.max(0, tier.limit - used) };
      }),
    });
  }

  if (pathname === "/api/login" && request.method === "POST") {
    if (!sameOrigin(request, env.PUBLIC_ORIGIN)) return json({ error: "Invalid request origin." }, 403);
    let body: { password?: unknown };
    try {
      body = (await request.json()) as { password?: unknown };
    } catch {
      return json({ error: "Invalid request." }, 400);
    }
    if (
      typeof body.password !== "string" ||
      !constantTimeEqual(body.password, env.UPLOAD_PASSWORD)
    ) {
      return json({ error: "That password did not match." }, 401);
    }
    const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const token = await signSession(expiry, env.SESSION_SECRET);
    return json(
      { ok: true },
      200,
      new Headers({
        "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
      }),
    );
  }

  if (pathname === "/api/logout" && request.method === "POST") {
    if (!sameOrigin(request, env.PUBLIC_ORIGIN)) return json({ error: "Invalid request origin." }, 403);
    return json(
      { ok: true },
      200,
      new Headers({ "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` }),
    );
  }

  if (!(await hasSession(request, env.SESSION_SECRET))) {
    return json({ error: "Sign in to continue." }, 401);
  }
  if (!sameOrigin(request, env.PUBLIC_ORIGIN)) return json({ error: "Invalid request origin." }, 403);

  if (pathname === "/api/uploads" && request.method === "GET") {
    const state = await registryFetch<{ videos: VideoRecord[] }>(env, "/state");
    return json({ videos: state.videos });
  }

  if (pathname === "/api/upload" && request.method === "POST") {
    const length = Number(request.headers.get("Content-Length"));
    if (!Number.isSafeInteger(length) || length < 1) {
      return json({ error: "The upload size could not be verified." }, 411);
    }
    if (length > MAX_UPLOAD_BYTES) {
      return json({ error: `This file exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} limit.` }, 413);
    }
    const tierId = request.headers.get("X-Upload-Tier") as TierId | null;
    if (!tierId || !Object.hasOwn(TIERS, tierId)) return json({ error: "Choose an expiry tier." }, 400);
    const contentType = (request.headers.get("Content-Type") ?? "").split(";")[0].toLowerCase();
    if (!VIDEO_TYPES.has(contentType)) return json({ error: "Use an MP4, WebM, MOV, or MKV video." }, 415);
    if (!request.body) return json({ error: "The upload has no file data." }, 400);

    const id = crypto.randomUUID();
    const now = Date.now();
    const title = (request.headers.get("X-Upload-Title") ?? "").trim().slice(0, 100) || "Untitled video";
    const description = (request.headers.get("X-Upload-Description") ?? "").trim().slice(0, 280);
    const video: VideoRecord = {
      id,
      tier: tierId,
      title,
      description,
      contentType,
      size: length,
      createdAt: now,
      expiresAt: now + TIERS[tierId].days * 24 * 60 * 60 * 1000,
      reservationExpiresAt: now + RESERVATION_SECONDS * 1000,
      status: "pending",
      hasPoster: false,
    };

    const reservation = await registryFetch<{ ok: boolean }>(env, "/reserve", {
      method: "POST",
      body: JSON.stringify(video),
    });
    if (!reservation.ok) return json({ error: "That expiry tier is full. Choose another." }, 409);

    let objectWritten = false;
    let bytesWritten = 0;
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesWritten += chunk.byteLength;
        if (bytesWritten > MAX_UPLOAD_BYTES || bytesWritten > length) {
          controller.error(new Error("Upload exceeds its declared size."));
          return;
        }
        controller.enqueue(chunk);
      },
    });
    try {
      const object = await env.VIDEOS_BUCKET.put(`videos/${id}`, request.body.pipeThrough(limiter), {
        httpMetadata: { contentType },
        customMetadata: { id, tier: tierId },
      });
      objectWritten = true;
      if (bytesWritten !== length || object.size !== length) throw new Error("Upload size mismatch.");
      const completed = await registryFetch<{ ok: boolean }>(env, "/complete", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      if (!completed.ok) throw new Error("Upload reservation expired.");
      return json({ id, shareUrl: `${new URL(request.url).origin}/v/${id}`, expiresAt: video.expiresAt }, 201);
    } catch {
      if (objectWritten) await env.VIDEOS_BUCKET.delete(`videos/${id}`);
      await registryFetch(env, "/release", { method: "POST", body: JSON.stringify({ id }) });
      return json({ error: "Upload failed. Check the file and try again." }, 500);
    }
  }

  const posterMatch = /^\/api\/videos\/([\da-f-]+)\/poster$/.exec(pathname);
  if (posterMatch && request.method === "POST") {
    const id = posterMatch[1];
    const contentType = request.headers.get("Content-Type")?.split(";")[0].toLowerCase();
    const length = Number(request.headers.get("Content-Length"));
    if (contentType !== "image/jpeg" || !Number.isSafeInteger(length) || length < 1 || length > MAX_POSTER_BYTES) {
      return json({ error: "Invalid preview image." }, 400);
    }
    const video = await registryFetch<VideoRecord | null>(env, `/video/${id}`);
    if (!video || video.status !== "active") return json({ error: "Video not found." }, 404);
    if (!request.body) return json({ error: "Preview image is empty." }, 400);
    let bytesWritten = 0;
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesWritten += chunk.byteLength;
        if (bytesWritten > MAX_POSTER_BYTES || bytesWritten > length) {
          controller.error(new Error("Preview image is too large."));
          return;
        }
        controller.enqueue(chunk);
      },
    });
    try {
      const poster = await env.VIDEOS_BUCKET.put(`posters/${id}.jpg`, request.body.pipeThrough(limiter), {
        httpMetadata: { contentType: "image/jpeg" },
      });
      if (bytesWritten !== length || poster.size !== length) throw new Error("Preview size mismatch.");
      const completed = await registryFetch<{ ok: boolean }>(env, "/poster-complete", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      if (!completed.ok) throw new Error("Video is no longer available.");
      return json({ ok: true });
    } catch {
      await env.VIDEOS_BUCKET.delete(`posters/${id}.jpg`);
      return json({ error: "Preview image could not be saved." }, 500);
    }
  }

  return json({ error: "Not found." }, 404);
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

export class VideoRegistry {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const now = Date.now();
    const stored = (await this.state.storage.get<VideoRecord[]>("videos")) ?? [];

    if (pathname === "/state" && request.method === "GET") {
      return json({
        videos: stored.filter((video) => video.status === "active" && video.expiresAt > now),
        pending: stored.filter((video) => video.status === "pending" && video.reservationExpiresAt > now),
      });
    }

    if (pathname.startsWith("/video/") && request.method === "GET") {
      const id = pathname.slice("/video/".length);
      return json(stored.find((video) => video.id === id && video.status === "active" && video.expiresAt > now) ?? null);
    }

    if (pathname === "/reserve" && request.method === "POST") {
      const candidate = (await request.json()) as VideoRecord;
      const reserved = await this.state.storage.transaction(async (transaction) => {
        const videos = (await transaction.get<VideoRecord[]>("videos")) ?? [];
        const current = videos.filter(
          (video) =>
            (video.status === "active" && video.expiresAt > now) ||
            (video.status === "pending" && video.reservationExpiresAt > now),
        );
        const tierCount = current.filter((video) => video.tier === candidate.tier).length;
        if (tierCount >= TIERS[candidate.tier].limit || current.some((video) => video.id === candidate.id)) {
          return false;
        }
        await transaction.put("videos", [...videos, candidate]);
        return true;
      });
      return json({ ok: reserved });
    }

    if (pathname === "/complete" && request.method === "POST") {
      const { id } = (await request.json()) as { id: string };
      const completed = await this.state.storage.transaction(async (transaction) => {
        const videos = (await transaction.get<VideoRecord[]>("videos")) ?? [];
        const video = videos.find((item) => item.id === id && item.status === "pending");
        if (video) {
          video.status = "active";
          await transaction.put("videos", videos);
        }
        return Boolean(video);
      });
      return json({ ok: completed });
    }

    if (pathname === "/poster-complete" && request.method === "POST") {
      const { id } = (await request.json()) as { id: string };
      const videos = (await this.state.storage.get<VideoRecord[]>("videos")) ?? [];
      const video = videos.find((item) => item.id === id && item.status === "active");
      if (video) {
        video.hasPoster = true;
        await this.state.storage.put("videos", videos);
      }
      return json({ ok: Boolean(video) });
    }

    if (pathname === "/release" && request.method === "POST") {
      const { id } = (await request.json()) as { id: string };
      const videos = (await this.state.storage.get<VideoRecord[]>("videos")) ?? [];
      await this.state.storage.put(
        "videos",
        videos.filter((video) => video.id !== id || video.status !== "pending"),
      );
      return json({ ok: true });
    }

    if (pathname === "/cleanup" && request.method === "POST") {
      const expired = stored.filter(
        (video) =>
          (video.status === "active" && video.expiresAt <= now) ||
          (video.status === "pending" && video.reservationExpiresAt <= now),
      );
      return json({ removed: expired });
    }

    if (pathname === "/purge" && request.method === "POST") {
      const { ids } = (await request.json()) as { ids: string[] };
      const remove = new Set(ids);
      await this.state.storage.transaction(async (transaction) => {
        const videos = (await transaction.get<VideoRecord[]>("videos")) ?? [];
        await transaction.put("videos", videos.filter((video) => !remove.has(video.id)));
      });
      return json({ ok: true });
    }

    return json({ error: "Not found." }, 404);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname.startsWith("/api/")) return await handleApi(request, env);
      const shareMatch = /^\/v\/([\da-f-]+)$/.exec(pathname);
      if (shareMatch && request.method === "GET") {
        const video = await registryFetch<VideoRecord | null>(env, `/video/${shareMatch[1]}`);
        if (!video) return secureHtml("<!doctype html><html><title>Video unavailable</title><p>This video has expired or no longer exists.</p></html>", 404);
        return sharePage(video, new URL(request.url));
      }
      const mediaMatch = /^\/media\/([\da-f-]+)$/.exec(pathname);
      if (mediaMatch && request.method === "GET") return await serveMedia(request, env, mediaMatch[1]);
      const posterMatch = /^\/poster\/([\da-f-]+)$/.exec(pathname);
      if (posterMatch && request.method === "GET") return await servePoster(env, posterMatch[1]);

      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch {
      return json({ error: "The request could not be completed." }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await registryFetch<{ removed: VideoRecord[] }>(env, "/cleanup", { method: "POST" });
    const results = await Promise.all(
      result.removed.map(async (video) => {
        try {
          await env.VIDEOS_BUCKET.delete(`videos/${video.id}`);
          await env.VIDEOS_BUCKET.delete(`posters/${video.id}.jpg`);
          return video.id;
        } catch {
          return null;
        }
      }),
    );
    const ids = results.filter((id): id is string => id !== null);
    if (ids.length) {
      await registryFetch(env, "/purge", { method: "POST", body: JSON.stringify({ ids }) });
    }
  },
};