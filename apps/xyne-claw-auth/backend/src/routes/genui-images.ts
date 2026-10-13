/**
 * Pictures for ```ui blocks. An agent writes {"type":"image","query":"Palolem
 * beach Goa","alt":"…"} instead of a URL it would have to guess, and the chat
 * (AI screen, AI sidebar, claw v3) asks this route for one matching photo and
 * shows it with a credit line — the same split as ChatGPT's AsyncImage: the
 * model names what to show, the server finds it.
 *
 * Source: Openverse (openverse.org), openly licensed photos from Flickr,
 * Wikimedia Commons and museum collections, with mature content filtered out
 * and each picture served through Openverse's own thumbnail proxy. Only
 * licences that allow commercial use are asked for. A result must share words
 * with the query in its title or tags: a wrong picture is worse than none, so a
 * miss answers `{ image: null }` and the chat leaves the picture out.
 *
 * Anonymous Openverse use allows about 20 requests a minute and 200 a day per
 * server. Set OPENVERSE_CLIENT_ID and OPENVERSE_CLIENT_SECRET (a free
 * registration) for higher limits. A found picture is cached per query for a
 * day, a miss for ten minutes (a thumbnail that would not load may be back),
 * and a failed lookup not at all: it answers 503 so the chat asks again later.
 * Concurrent lookups of one query share one upstream call.
 */
import { Router, type Request, type Response } from "express";
import type { UiImageHit } from "xyne-claw-shared/gen-ui";
import { createLogger } from "../logger.js";
import { createRequesterLimiter } from "../middleware/rate-limiters.js";

const log = createLogger("genui-images");

const API = "https://api.openverse.org/v1";
const USER_AGENT = "xyne-claw-auth/1.0 (generative UI images)";
const TIMEOUT_MS = 6_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 1_000;
const QUERY_MAX = 120;
const STOPWORDS = new Set(["the", "and", "for", "with", "from", "into", "onto", "that", "this", "your", "photo", "image", "picture", "photograph", "view", "shot"]);

interface OpenverseImage {
  title?: string | null;
  creator?: string | null;
  license?: string | null;
  license_version?: string | null;
  license_url?: string | null;
  source?: string | null;
  url?: string | null;
  thumbnail?: string | null;
  width?: number | null;
  height?: number | null;
  foreign_landing_url?: string | null;
  mature?: boolean | null;
  tags?: { name?: string | null }[] | null;
}

/** The cache key and the text sent upstream: lower case, one space, bounded. */
export function normalizeImageQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim().slice(0, QUERY_MAX);
}

/** Words that can tell two pictures apart, folded so "Clouds" meets "cloud". */
function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").split(" ")) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw.length > 4 ? raw.replace(/(?:es|s)$/, "") : raw);
  }
  return out;
}

const isHttps = (u: unknown): u is string => typeof u === "string" && /^https:\/\/[^\s"'<>\\]+$/i.test(u) && u.length <= 2_000;

function licenceLabel(code: string, version: string | null | undefined): string {
  if (code === "cc0") return "CC0";
  if (code === "pdm") return "Public domain";
  return `CC ${code.toUpperCase()}${version ? ` ${version}` : ""}`;
}

/**
 * The results that match `query`, best first. A result counts only when it
 * shares at least a third of the query's keywords (at least one) with its
 * title and tags; the closest match comes first, then Openverse's own order.
 */
export function rankImages(query: string, results: readonly OpenverseImage[]): UiImageHit[] {
  const wanted = keywords(query);
  if (wanted.size === 0) return [];
  const needed = Math.max(1, Math.ceil(wanted.size / 3));
  const ranked: { score: number; hit: UiImageHit }[] = [];
  for (const r of results) {
    if (r.mature) continue;
    const src = isHttps(r.thumbnail) ? r.thumbnail : isHttps(r.url) ? r.url : null;
    if (!src) continue;
    const have = keywords([r.title ?? "", ...(r.tags ?? []).map((t) => t.name ?? "")].join(" "));
    let score = 0;
    for (const w of wanted) if (have.has(w)) score++;
    if (score < needed) continue;
    ranked.push({
      score,
      hit: {
        src,
        ...(typeof r.width === "number" ? { width: r.width } : {}),
        ...(typeof r.height === "number" ? { height: r.height } : {}),
        ...(r.title ? { title: r.title.slice(0, 200) } : {}),
        ...(isHttps(r.foreign_landing_url) ? { sourceUrl: r.foreign_landing_url } : {}),
        ...(r.creator || r.source ? { credit: (r.creator || r.source || "").slice(0, 120) } : {}),
        ...(r.license ? { license: licenceLabel(r.license, r.license_version) } : {}),
        ...(isHttps(r.license_url) ? { licenseUrl: r.license_url } : {}),
      },
    });
  }
  // Array.prototype.sort is stable, so equal scores keep Openverse's order.
  return ranked.sort((a, b) => b.score - a.score).map((r) => r.hit);
}

/** The best match for `query`, or null (no reachability check). */
export function pickImage(query: string, results: readonly OpenverseImage[]): UiImageHit | null {
  return rankImages(query, results)[0] ?? null;
}

/**
 * True when `src` answers with an image. Openverse's thumbnail proxy answers
 * 424 when it cannot reach the original, which would leave an empty box in
 * the chat, so a picture is only handed out after this check.
 */
async function loads(src: string): Promise<boolean> {
  try {
    const res = await fetch(src, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ok = res.ok && (res.headers.get("content-type") ?? "").startsWith("image/");
    await res.body?.cancel().catch(() => {});
    return ok;
  } catch {
    return false;
  }
}

/** The first of the best few matches that actually loads. */
export async function firstLoadingImage(hits: readonly UiImageHit[], check: (src: string) => Promise<boolean> = loads): Promise<UiImageHit | null> {
  for (const hit of hits.slice(0, 3)) if (await check(hit.src)) return hit;
  return null;
}

let token: { value: string; until: number } | undefined;

/** A bearer token from OPENVERSE_CLIENT_ID/SECRET when they are set; anonymous otherwise. */
async function accessToken(): Promise<string | undefined> {
  const id = process.env["OPENVERSE_CLIENT_ID"];
  const secret = process.env["OPENVERSE_CLIENT_SECRET"];
  if (!id || !secret) return undefined;
  if (token && token.until > Date.now()) return token.value;
  const res = await fetch(`${API}/auth_tokens/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    log.warn(`[genui-images] Openverse token request failed (${res.status}); searching anonymously`);
    return undefined;
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) return undefined;
  token = { value: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3_600) - 60) * 1_000 };
  return token.value;
}

async function openverseResults(query: string): Promise<OpenverseImage[]> {
  const params = new URLSearchParams({ q: query, page_size: "12", license_type: "commercial", mature: "false" });
  const bearer = await accessToken().catch(() => undefined);
  const res = await fetch(`${API}/images/?${params}`, {
    headers: { accept: "application/json", "user-agent": USER_AGENT, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Openverse answered ${res.status}`);
  const body = (await res.json()) as { results?: OpenverseImage[] };
  return body.results ?? [];
}

/**
 * Shorter forms of a query to try when the whole one finds nothing: its first
 * three, then first two, keywords ("meenakshi temple gopuram dravida style" →
 * "meenakshi temple gopuram"). Agents tend to over-describe; Openverse matches
 * every word.
 */
export function fallbackQueries(query: string): string[] {
  const words = [...keywords(query)];
  const out: string[] = [];
  for (const n of [3, 2]) {
    if (words.length > n) out.push(words.slice(0, n).join(" "));
  }
  return out;
}

/** The whole query first, then up to two shorter forms; a hit must match its own query and load. */
async function searchOpenverse(query: string): Promise<UiImageHit | null> {
  for (const q of [query, ...fallbackQueries(query)]) {
    const hit = await firstLoadingImage(rankImages(q, await openverseResults(q)));
    if (hit) return hit;
  }
  return null;
}

const cache = new Map<string, { until: number; hit: Promise<UiImageHit | null> }>();

/** One picture for a normalized query: a hit is cached for a day, a miss for ten minutes, a failure not at all. */
export function findGenUiImage(query: string, search: (q: string) => Promise<UiImageHit | null> = searchOpenverse): Promise<UiImageHit | null> {
  const key = normalizeImageQuery(query);
  const cached = cache.get(key);
  if (cached && Date.now() < cached.until) return cached.hit;
  const entry = { until: Date.now() + CACHE_TTL_MS, hit: Promise.resolve<UiImageHit | null>(null) };
  entry.hit = search(key).then(
    (found) => {
      if (!found) entry.until = Math.min(entry.until, Date.now() + MISS_TTL_MS);
      return found;
    },
    (err: unknown) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw err;
    },
  );
  cache.set(key, entry);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return entry.hit;
}

/** Test hook: forget every cached lookup. */
export function clearGenUiImageCache(): void {
  cache.clear();
}

export const genUiImagesRouter = Router();

genUiImagesRouter.get("/image", createRequesterLimiter({ windowMs: 60 * 1000, max: 60 }), async (req: Request, res: Response) => {
  const raw = req.query["q"];
  const query = typeof raw === "string" ? normalizeImageQuery(raw) : "";
  if (query.length < 2) {
    res.status(400).json({ error: "q is required" });
    return;
  }
  try {
    const image = await findGenUiImage(query);
    res.set("Cache-Control", image ? "private, max-age=86400" : "no-store");
    res.json({ image });
  } catch (err) {
    log.warn(`[genui-images] lookup failed for "${query}": ${err instanceof Error ? err.message : String(err)}`);
    // Not a miss: the chat leaves the picture out and asks again on a later render.
    res.set("Cache-Control", "no-store");
    res.status(503).json({ image: null, error: "image lookup failed" });
  }
});
