import { DEFAULT_MODEL, getLocal, setLocal, type Mode, type Usage, type UsageBucket } from "./shared";

// Every id passed here is in options.html, so a miss is a bug.
function $<E extends HTMLElement = HTMLElement>(id: string): E {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Claude Overview settings: missing #${id}`);
  return el as E;
}

const modeInput = (mode: Mode) => document.querySelector<HTMLInputElement>(`input[name=mode][value=${mode}]`);
const checkedMode = (): Mode => document.querySelector<HTMLInputElement>("input[name=mode]:checked")?.value === "click" ? "click" : "auto";

void getLocal("apiKey", "model", "mode").then(({ apiKey, model, mode }) => {
  $<HTMLInputElement>("key").value = apiKey ?? "";
  $<HTMLInputElement>("model").value = model || DEFAULT_MODEL;
  const radio = modeInput(mode === "click" ? "click" : "auto");
  if (radio) radio.checked = true;
});

$("save").onclick = async () => {
  await setLocal({
    apiKey: $<HTMLInputElement>("key").value.trim(),
    model: $<HTMLInputElement>("model").value.trim() || DEFAULT_MODEL,
    mode: checkedMode()
  });
  $("status").textContent = "Settings saved";
  setTimeout(() => ($("status").textContent = ""), 2000);
};

// ---------- usage ----------
const money = (n: number) => "$" + (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));
const count = (n: number) => n.toLocaleString();
const plural = (n: number) => `${count(n)} overview${n === 1 ? "" : "s"}`;
const dayKey = (d: Date) => d.toLocaleDateString("en-CA");

interface Total { requests: number; cost: number; unpriced: number }

function sum(buckets: Array<UsageBucket | undefined>): Total {
  return buckets.reduce<Total>((t, b) => ({
    requests: t.requests + (b?.requests ?? 0),
    cost: t.cost + (b?.cost ?? 0),
    unpriced: t.unpriced + (b?.unpriced ?? 0)
  }), { requests: 0, cost: 0, unpriced: 0 });
}

function renderUsage(usage: Usage = {}): void {
  const days = usage.days ?? {};
  const today = sum([days[dayKey(new Date())]]);
  const last30 = sum(Array.from({ length: 30 }, (_, i) => days[dayKey(new Date(Date.now() - i * 864e5))]));
  const all = sum(Object.values(days));

  $("u-today").textContent = money(today.cost); $("u-today-n").textContent = plural(today.requests);
  $("u-30").textContent = money(last30.cost); $("u-30-n").textContent = plural(last30.requests);
  $("u-all").textContent = money(all.cost); $("u-all-n").textContent = plural(all.requests);

  $("usage-since").textContent = usage.since
    ? `Estimated from token counts since ${new Date(usage.since).toLocaleDateString()}. Your Anthropic Console bill is the source of truth.`
    : "No overviews generated yet.";

  const rows = Object.entries(usage.models ?? {}).sort((a, b) => b[1].cost - a[1].cost);
  const table = $<HTMLTableElement>("u-models");
  table.hidden = !rows.length;
  table.tBodies[0]?.replaceChildren(...rows.map(([model, b]) => {
    const tr = document.createElement("tr");
    for (const v of [model, count(b.requests), count(b.input), count(b.output), b.unpriced ? "unknown price" : money(b.cost)]) {
      const td = document.createElement("td"); td.textContent = v; tr.append(td);
    }
    return tr;
  }));

  const notes: string[] = [];
  if (usage.cacheHits) notes.push(`${plural(usage.cacheHits)} reused from the session cache at no cost.`);
  if (all.unpriced) notes.push(`${plural(all.unpriced)} used a model with no known price and aren't included in the totals.`);
  $("u-notes").textContent = notes.join(" ");
}

void getLocal("usage").then(({ usage }) => renderUsage(usage));
chrome.storage.onChanged.addListener((changes, area) => {
  const change = changes["usage"];
  if (area === "local" && change) renderUsage(change.newValue as Usage | undefined);
});

$("reset-usage").onclick = async () => {
  await chrome.storage.local.remove("usage");
  renderUsage();
};
