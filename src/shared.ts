// Types and helpers shared by the background worker, the content script and the options page.

export const DEFAULT_MODEL = "claude-haiku-5-5";

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
export type RuntimeMessage = { type: "openOptions" };

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

export async function getCachedOverview(key: string): Promise<CachedOverview | undefined> {
  const got = (await chrome.storage.session.get(key)) as Record<string, CachedOverview | undefined>;
  return got[key];
}

export function setCachedOverview(key: string, value: CachedOverview): Promise<void> {
  return chrome.storage.session.set({ [key]: value });
}

export function sendRuntimeMessage(msg: RuntimeMessage): void {
  void chrome.runtime.sendMessage(msg);
}

export function isRuntimeMessage(m: unknown): m is RuntimeMessage {
  return typeof m === "object" && m !== null && (m as { type?: unknown }).type === "openOptions";
}

// Ports carry whatever the other end posts, so the background checks the shape before trusting it.
export function isStartMessage(m: unknown): m is StartMessage {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Partial<Record<keyof StartMessage, unknown>>;
  return o.type === "start" &&
    typeof o.engine === "string" &&
    typeof o.query === "string" &&
    typeof o.force === "boolean" &&
    Array.isArray(o.sources) &&
    o.sources.every(isSource);
}

function isSource(s: unknown): s is Source {
  if (typeof s !== "object" || s === null) return false;
  const o = s as Partial<Record<keyof Source, unknown>>;
  return typeof o.title === "string" && typeof o.url === "string" && typeof o.host === "string" &&
    typeof o.icon === "string" && typeof o.snippet === "string";
}
