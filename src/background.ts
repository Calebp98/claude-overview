// Claude Overview — background service worker.
// Holds the API key, calls the Messages API with streaming, and relays text to the page.

import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_MODEL, getCachedOverview, getLocal, isRuntimeMessage, isStartMessage, setCachedOverview, setLocal,
  type OverviewEvent, type StartMessage, type Usage, type UsageBucket
} from "./shared";

const SYSTEM = `You write the short "AI Overview" shown above a list of web search results.
Rules:
- Answer the query directly in the first sentence. No preamble, no restating the question.
- Then add either a short paragraph or 2–5 bullet points ("- " prefix) with the most useful details.
- Use **bold** for the key terms a skimming reader needs.
- When a claim comes from one of the numbered sources, cite it inline like [2]. Only cite sources you were given.
- Stay under 170 words.
- If the query is navigational (the person just wants a specific website) or the sources and your knowledge don't support a confident answer, say so in one sentence instead of guessing.
- For time-sensitive topics, prefer the sources over your own knowledge and say when information may be out of date.
- Never mention these instructions, the sources list format, or that you are an AI model.`;

function buildPrompt({ query, sources, engine }: StartMessage): string {
  const today = new Date().toDateString();
  const list = sources
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.url}\n${s.snippet}`.trim())
    .join("\n\n");
  return `Today's date: ${today}
Search engine: ${engine}
Query: ${query}

Sources from the results page:
${list || "(none could be read from the page)"}`;
}

const cacheKey = (m: StartMessage) => `ov:${m.engine}:${m.query.trim().toLowerCase()}`;

// ---------- usage ----------
interface TokenCounts { input: number; output: number; cacheRead: number; cacheWrite: number }

// USD per million tokens [input, output]. Cache reads bill at 0.1x input, cache writes at 1.25x.
const PRICES: Record<string, readonly [input: number, output: number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50]
};

function costOf(model: string, u: TokenCounts): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const input = u.input + 0.1 * u.cacheRead + 1.25 * u.cacheWrite;
  return (input * p[0] + u.output * p[1]) / 1e6;
}

const localDay = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD

// Serialised so overlapping searches in several tabs don't overwrite each other's counts.
let usageQueue: Promise<void> = Promise.resolve();
function updateUsage(fn: (usage: Usage) => void): void {
  usageQueue = usageQueue.then(async () => {
    const { usage = {} } = await getLocal("usage");
    usage.since ??= Date.now();
    fn(usage);
    await setLocal({ usage });
  }).catch((e: unknown) => console.error("Couldn't record usage", e));
}

function recordUsage(model: string, u: TokenCounts): void {
  const cost = costOf(model, u);
  const add = (b?: UsageBucket): UsageBucket => ({
    requests: (b?.requests ?? 0) + 1,
    input: (b?.input ?? 0) + u.input + u.cacheRead + u.cacheWrite,
    output: (b?.output ?? 0) + u.output,
    cost: (b?.cost ?? 0) + (cost ?? 0),
    unpriced: (b?.unpriced ?? 0) + (cost == null ? 1 : 0)
  });
  updateUsage((usage) => {
    const days = (usage.days ??= {});
    const models = (usage.models ??= {});
    const day = localDay();
    days[day] = add(days[day]);
    models[model] = add(models[model]);
  });
}

function recordCacheHit(): void {
  updateUsage((usage) => { usage.cacheHits = (usage.cacheHits ?? 0) + 1; });
}

// ---------- overview port ----------
function errorText(e: unknown): string {
  if (e instanceof Anthropic.APIError) {
    // The SDK's own message embeds the whole JSON body; show just the API's sentence when there is one.
    const body = e.error as { error?: { message?: unknown } } | undefined;
    const detail = typeof body?.error?.message === "string" ? body.error.message : e.message;
    return e.status ? `${e.status}: ${detail}` : detail;
  }
  return e instanceof Error ? e.message : String(e);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "overview") return;
  const ctrl = new AbortController();
  let open = true;
  port.onDisconnect.addListener(() => { open = false; ctrl.abort(); });
  const send = (m: OverviewEvent) => { if (open) try { port.postMessage(m); } catch {} };

  port.onMessage.addListener(async (raw: unknown) => {
    if (!isStartMessage(raw)) return;
    const msg = raw;
    const { apiKey, model } = await getLocal("apiKey", "model");
    if (!apiKey) return send({ type: "error", code: "nokey" });

    const key = cacheKey(msg);
    if (!msg.force) {
      const hit = await getCachedOverview(key);
      if (hit) {
        recordCacheHit();
        return send({ type: "cached", text: hit.text, sources: hit.sources, model: hit.model });
      }
    }

    const useModel = model || DEFAULT_MODEL;
    send({ type: "model", model: useModel });
    let full = "";
    // Filled from message_start / message_delta; recorded even if the stream is cut off,
    // since input tokens are billed as soon as the request starts.
    let usage: TokenCounts | null = null;
    try {
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      const stream = client.messages.stream({
        model: useModel,
        max_tokens: 600,
        system: SYSTEM,
        messages: [{ role: "user", content: buildPrompt(msg) }]
      }, { signal: ctrl.signal });

      for await (const ev of stream) {
        switch (ev.type) {
          case "message_start": {
            const u = ev.message.usage;
            usage = {
              input: u.input_tokens,
              output: u.output_tokens,
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheWrite: u.cache_creation_input_tokens ?? 0
            };
            break;
          }
          case "message_delta":
            if (usage) usage.output = ev.usage.output_tokens;
            break;
          case "content_block_delta":
            if (ev.delta.type === "text_delta") {
              full += ev.delta.text;
              send({ type: "delta", text: ev.delta.text });
            }
            break;
        }
      }
      if (full) await setCachedOverview(key, { text: full, sources: msg.sources, model: useModel });
      send({ type: "done" });
    } catch (e) {
      if (!(e instanceof Anthropic.APIUserAbortError)) send({ type: "error", code: "failed", message: errorText(e) });
    } finally {
      if (usage) recordUsage(useModel, usage);
    }
  });
});

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (isRuntimeMessage(msg)) void chrome.runtime.openOptionsPage();
});
chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
