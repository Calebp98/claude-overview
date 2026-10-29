// Types and helpers shared by the background worker, the content script and the options page.

export const DEFAULT_MODEL = "claude-haiku-5-5";

// Size limits for what a content script may send. The content script trims to these;
// the background rejects anything over them.
export const LIMITS = {
  query: 500,
  sources: 8,
  title: 140,
  snippet: 320,
  url: 2048,
  host: 253,
  engine: 40
} as const;

// Returns the URL only if it parses as http(s), so it is safe for an href or src.
export function safeHttpUrl(s: string): string | null {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

export interface Source {
  title: string;
  url: string;
  host: string;
  icon: string;
  snippet: string;
}

// ---------- messages ----------
// Content script -> background, over the "overview" port.
export interface StartMessage {
  type: "start";
  engine: string;
  query: string;
  sources: Source[];
  force: boolean;
}

// Background -> content script, over the same port.
export type OverviewEvent =
  | { type: "model"; model: string }
  | { type: "delta"; text: string }
  | { type: "cached"; text: string; sources: Source[]; model: string }
  | { type: "done" }
  | { type: "error"; code: "nokey" }
  | { type: "error"; code: "failed"; message: string };

// One-off chrome.runtime.sendMessage calls.
export type RuntimeMessage = { type: "openOptions" } | { type: "getSettings" };

// The background's reply to getSettings. Content scripts can't read chrome.storage.local
// (it holds the API key), so they ask for just the settings they need.
export interface PageSettings {
  model: string;
  mode: Mode;
}

// ---------- storage ----------
export type Mode = "auto" | "click";

export interface UsageBucket {
  requests: number;
  input: number;
  output: number;
  cost: number;
  unpriced: number;
}

export interface Usage {
  since?: number;
  cacheHits?: number;
  days?: Record<string, UsageBucket>;
  models?: Record<string, UsageBucket>;
}

export interface LocalStore {
  apiKey?: string;
  model?: string;
  mode?: Mode;
  usage?: Usage;
}

export interface CachedOverview {
  text: string;
  sources: Source[];
  model: string;
}

// chrome.storage is untyped; these are the only places its results are cast.
export async function getLocal<K extends keyof LocalStore>(...keys: K[]): Promise<Pick<LocalStore, K>> {
  return (await chrome.storage.local.get(keys)) as Pick<LocalStore, K>;
}

export function setLocal(items: LocalStore): Promise<void> {
  return chrome.storage.local.set(items);
}

export function openOptions(): void {
  const msg: RuntimeMessage = { type: "openOptions" };
  void chrome.runtime.sendMessage(msg);
}

export async function requestPageSettings(): Promise<PageSettings> {
  const msg: RuntimeMessage = { type: "getSettings" };
  const res = (await chrome.runtime.sendMessage(msg)) as Partial<PageSettings> | undefined;
  return { model: res?.model || DEFAULT_MODEL, mode: res?.mode === "click" ? "click" : "auto" };
}

export function isRuntimeMessage(m: unknown): m is RuntimeMessage {
  if (typeof m !== "object" || m === null) return false;
  const type = (m as { type?: unknown }).type;
  return type === "openOptions" || type === "getSettings";
}

// Ports carry whatever the other end posts, so the background checks the shape before trusting it.
export function isStartMessage(m: unknown): m is StartMessage {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Partial<Record<keyof StartMessage, unknown>>;
  return o.type === "start" &&
    isString(o.engine, LIMITS.engine) &&
    isString(o.query, LIMITS.query) &&
    typeof o.force === "boolean" &&
    Array.isArray(o.sources) &&
    o.sources.length <= LIMITS.sources &&
    o.sources.every(isSource);
}

const isString = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

function isSource(s: unknown): s is Source {
  if (typeof s !== "object" || s === null) return false;
  const o = s as Partial<Record<keyof Source, unknown>>;
  return isString(o.title, LIMITS.title) &&
    isString(o.snippet, LIMITS.snippet) &&
    isString(o.host, LIMITS.host) &&
    isString(o.url, LIMITS.url) && safeHttpUrl(o.url) !== null &&
    isString(o.icon, LIMITS.url) && (o.icon === "" || safeHttpUrl(o.icon) !== null);
}
