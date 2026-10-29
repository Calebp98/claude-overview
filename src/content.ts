// Claude Overview: a quiet answer card above search results, labelled with the model that wrote it.
import {
  DEFAULT_MODEL, LIMITS, openOptions, requestPageSettings, safeHttpUrl,
  type OverviewEvent, type Source, type StartMessage
} from "./shared";

declare global {
  interface Window { __claudeOverview?: boolean }
}

(() => {
  // Own-property check: a page element with id="__claudeOverview" shows up on window via
  // named access (from the prototype chain), which a plain truthiness check would mistake for us.
  if (Object.hasOwn(window, "__claudeOverview")) return;
  window.__claudeOverview = true;

  // ---------- engines ----------
  type Where = "before" | "prepend";
  interface Spot { el: Element; where: Where }
  interface Engine {
    id: string;
    test: (u: URL) => boolean;
    param: string;
    maxWidth?: string;
    // The first mount that resolves wins.
    mounts: Array<() => Spot | null>;
  }

  const q = (s: string) => document.querySelector(s);
  const at = (s: string, where: Where): Spot | null => {
    const el = q(s);
    return el ? { el, where } : null;
  };

  const ENGINES: Engine[] = [
    {
      id: "Google",
      test: (u) => /(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === "/search" &&
        !u.searchParams.get("tbm") && ["", "14"].includes(u.searchParams.get("udm") ?? ""),
      param: "q",
      maxWidth: "652px",
      mounts: [() => at("#rso", "before"), () => at("#center_col", "prepend")]
    },
    {
      id: "DuckDuckGo",
      test: (u) => u.hostname === "duckduckgo.com" && u.pathname === "/" && !!u.searchParams.get("q") &&
        !u.searchParams.get("iax") && !/images|videos|maps|news/.test(u.searchParams.get("ia") ?? ""),
      param: "q",
      mounts: [
        // Inside the results list, right before the first organic result (below the filter bar).
        () => {
          const li = q('[data-testid="mainline"] article[data-testid="result"]')?.closest("li");
          return li ? { el: li, where: "before" } : null;
        },
        () => at(".react-results--main", "prepend")
      ]
    },
    {
      id: "Bing",
      test: (u) => u.hostname.endsWith("bing.com") && u.pathname === "/search",
      param: "q",
      mounts: [() => at("#b_results > li.b_algo", "before")]
    },
    {
      id: "Brave Search",
      test: (u) => u.hostname === "search.brave.com" && u.pathname === "/search",
      param: "q",
      mounts: [() => at("#results .snippet[data-type='web']", "before"), () => at("#results", "prepend")]
    },
    {
      id: "Kagi",
      test: (u) => u.hostname === "kagi.com" && u.pathname === "/search",
      param: "q",
      mounts: [() => at(".results-box", "prepend")]
    }
  ];

  const findSpot = (engine: Engine) => engine.mounts.map((f) => f()).find((s) => s !== null) ?? null;

  const current = (): { engine: Engine; query: string } | null => {
    const u = new URL(location.href);
    const engine = ENGINES.find((x) => x.test(u));
    // Collapsed to one line and capped, so a crafted link can't send a huge or multi-line prompt.
    const query = engine ? (u.searchParams.get(engine.param) ?? "").replace(/\s+/g, " ").trim().slice(0, LIMITS.query) : "";
    return engine && query ? { engine, query } : null;
  };

  // "claude-haiku-5-5" -> "Claude Haiku 5.5"; drops a trailing date stamp.
  function modelLabel(id: string): string {
    const parts = (id || DEFAULT_MODEL).split("-").filter((p) => !/^\d{8}$/.test(p));
    const words: string[] = [], nums: string[] = [];
    for (const p of parts) (/^\d+$/.test(p) ? nums : words).push(p);
    const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    return nums.length ? `${name} ${nums.join(".")}` : name;
  }

  // ---------- sources ----------
  const BLOCK = "article, li, .g, .b_algo, .snippet, .search-result, [data-testid='result']";

  function scrapeSources(max = 8): Source[] {
    const here = location.hostname;
    const seen = new Set<string>();
    const out: Source[] = [];
    for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href^='http']")) {
      if (out.length >= max) break;
      if (a.closest("#claude-overview-host")) continue;
      const heading = a.querySelector<HTMLElement>("h2, h3") ?? a.closest<HTMLElement>("h2, h3");
      if (!heading) continue;
      let url: URL;
      try { url = new URL(a.href); } catch { continue; }
      // Only http(s) links may become clickable citations in the card.
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      if (url.hostname === here || /(^|\.)google\.|bing\.com$/.test(url.hostname)) continue;
      const key = url.origin + url.pathname;
      if (seen.has(key)) continue;
      const title = (heading.innerText || a.innerText || "").trim().replace(/\s+/g, " ");
      if (title.length < 4 || url.href.length > LIMITS.url) continue;
      seen.add(key);

      const block = a.closest<HTMLElement>(BLOCK) ?? a.parentElement?.parentElement?.parentElement ?? a;
      const text = (block.innerText || "").replace(/\s+/g, " ").trim();
      const snippet = text.replace(title, "").trim().slice(0, LIMITS.snippet);
      // Reuse the favicon the search page already shows, so no extra third-party requests.
      const img = [...block.querySelectorAll("img")].find((i) =>
        /favicon|\.ico|ip3|s2\/fav|faviconV2|imgs\.search\.brave/.test(i.src) || (i.width && i.width <= 32));
      out.push({
        title: title.slice(0, LIMITS.title),
        url: url.href,
        host: url.hostname.replace(/^www\./, ""),
        icon: img && img.src.length <= LIMITS.url ? safeHttpUrl(img.src) ?? "" : "",
        snippet
      });
    }
    return out;
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function waitFor<T>(fn: () => T, timeout = 3000): Promise<T> {
    const end = Date.now() + timeout;
    let v = fn();
    while (!v && Date.now() < end) { await sleep(150); v = fn(); }
    return v;
  }

  // ---------- markdown ----------
  // Everything that reaches innerHTML goes through esc() first; only the tags below are added back.
  const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

  function inline(s: string, sources: Source[]): string {
    s = esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    return s.replace(/\s?\[(\d+(?:\s*,\s*\d+)*)\]/g, (_: string, nums: string) =>
      nums.split(/\s*,\s*/).map((n) => {
        const src = sources[+n - 1];
        const href = src && safeHttpUrl(src.url);
        return src && href ? `<a class="cite" href="${esc(href)}" title="${esc(src.host)}" target="_blank" rel="noopener">${n}</a>` : "";
      }).join("")
    );
  }

  function render(md: string, sources: Source[]): string {
    let html = "", list = false, para: string[] = [];
    const flush = () => { if (para.length) { html += `<p>${inline(para.join(" "), sources)}</p>`; para = []; } };
    const close = () => { if (list) { html += "</ul>"; list = false; } };
    for (const raw of md.split("\n")) {
      const line = raw.trim();
      const li = line.match(/^[-*•]\s+(.*)/) ?? line.match(/^\d+[.)]\s+(.*)/);
      const h = line.match(/^#{1,4}\s+(.*)/);
      if (!line) { flush(); close(); continue; }
      if (li) { flush(); if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(li[1] ?? "", sources)}</li>`; continue; }
      if (h) { flush(); close(); html += `<h4>${inline(h[1] ?? "", sources)}</h4>`; continue; }
      close(); para.push(line);
    }
    flush(); close();
    return html;
  }

  // ---------- styles ----------
  // Monochrome and borrowed from the host page: text colour and font come from the
  // results around the card, so it sits in light or dark themes without its own palette.
  const CSS = `
    :host { all: initial; display: block; list-style: none; margin: 4px 0 28px; }
    .card {
      --fg: var(--page-fg, #1c1c1c);
      --muted: color-mix(in srgb, var(--fg) 58%, transparent);
      --faint: color-mix(in srgb, var(--fg) 6%, transparent);
      --line: color-mix(in srgb, var(--fg) 12%, transparent);
      font: 15px/1.6 var(--page-font, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif);
      color: var(--fg);
      background: var(--faint);
      border-radius: 16px;
      padding: 14px 18px 12px;
    }
    .head { display: flex; align-items: center; gap: 8px; height: 28px; margin-bottom: 6px; }
    .mark { width: 16px; height: 16px; flex: none; color: var(--fg); }
    .model { flex: 1; font-size: 13px; font-weight: 600; letter-spacing: .01em; }
    .btn { all: unset; cursor: pointer; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; color: var(--muted); }
    .btn svg { width: 15px; height: 15px; }
    .btn:hover { background: var(--line); color: var(--fg); }
    .btn:focus-visible, .more:focus-visible, .go:focus-visible, .src:focus-visible, .cite:focus-visible {
      outline: 2px solid var(--fg); outline-offset: 2px; }

    .body { overflow: hidden; }
    .body.clamped { max-height: 190px; -webkit-mask-image: linear-gradient(#000 55%, transparent); mask-image: linear-gradient(#000 55%, transparent); }
    .text p { margin: 0 0 8px; }
    .text ul { margin: 0 0 8px; padding-left: 18px; }
    .text li { margin: 0 0 4px; }
    .text li::marker { color: var(--muted); }
    .text h4 { margin: 10px 0 2px; font-size: 15px; font-weight: 600; }
    .text strong { font-weight: 600; }
    .cite { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 3px; margin-left: 3px;
      font-size: 10.5px; font-weight: 600; line-height: 1; border-radius: 5px; background: var(--line); color: var(--muted);
      text-decoration: none; vertical-align: 2px; }
    .cite:hover { background: var(--fg); color: var(--page-bg, #fff); }
    .caret { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--fg); margin-left: 4px;
      vertical-align: 2px; animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .25; } }

    .skeleton { display: grid; gap: 9px; padding: 4px 0 10px; }
    .skeleton span { height: 12px; border-radius: 6px; background: var(--line); animation: pulse 1.4s ease-in-out infinite; }
    .skeleton span:nth-child(2) { width: 88%; animation-delay: .15s; }
    .skeleton span:nth-child(3) { width: 62%; animation-delay: .3s; }

    .more { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; margin: 2px 0 0;
      font-size: 13px; font-weight: 600; color: var(--muted); border-radius: 6px; padding: 2px 4px 2px 0; }
    .more:hover { color: var(--fg); }
    .more svg { width: 14px; height: 14px; transition: transform .15s; }
    .more[aria-expanded="true"] svg { transform: rotate(180deg); }

    .sources { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 12px; }
    .src { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; height: 26px; padding: 0 9px 0 4px;
      border-radius: 13px; background: var(--faint); box-shadow: inset 0 0 0 1px var(--line);
      color: var(--fg); text-decoration: none; font-size: 12.5px; }
    .src:hover { background: var(--line); }
    .src img, .src .ph { width: 18px; height: 18px; border-radius: 50%; flex: none; object-fit: cover; }
    .src .ph { display: grid; place-items: center; background: var(--line); font-size: 10px; font-weight: 700; color: var(--muted); }
    .src .h { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .src .n { color: var(--muted); font-variant-numeric: tabular-nums; }

    .foot { display: flex; align-items: center; gap: 10px; padding-top: 10px; color: var(--muted); font-size: 12px; }
    .foot .grow { flex: 1; }
    .go { all: unset; cursor: pointer; padding: 6px 14px; border-radius: 9px; background: var(--fg); color: var(--page-bg, #fff);
      font-size: 13px; font-weight: 600; }
    .note { color: var(--muted); margin: 0 0 4px; font-size: 14px; }
    .note a { color: var(--fg); text-decoration: underline; cursor: pointer; }
    @media (prefers-reduced-motion: reduce) { .caret, .skeleton span { animation: none; } .more svg { transition: none; } }
  `;

  const ICON = {
    mark: `<svg class="mark" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.5c.4 3.3 2 4.9 5.3 5.3v.4C10 7.6 8.4 9.2 8 12.5h-.4C7.2 9.2 5.6 7.6 2.3 7.2v-.4C5.6 6.4 7.2 4.8 7.6 1.5H8Z"/></svg>`,
    regen: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8"/><path d="M13.3 2.5v3h-3"/></svg>`,
    close: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
    chev: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>`
  };

  // ---------- page theme ----------
  function pageBackground(el: Element): string {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && !/rgba\(.*,\s*0\)|transparent/.test(c)) return c;
    }
    return getComputedStyle(document.documentElement).backgroundColor || "#fff";
  }

  function adoptTheme(card: HTMLElement, anchor: Element): void {
    const cs = getComputedStyle(anchor.querySelector("p, span") ?? anchor);
    card.style.setProperty("--page-fg", cs.color);
    card.style.setProperty("--page-font", cs.fontFamily);
    card.style.setProperty("--page-bg", pageBackground(anchor));
  }

  // ---------- UI ----------
  interface State {
    text: string;
    sources: Source[];
    query: string;
    model: string;
    done: boolean;
    error: string; // HTML, already escaped
  }

  let host: HTMLElement | undefined;
  let root: ShadowRoot | undefined;
  let port: chrome.runtime.Port | undefined;
  let state: State | null = null;
  let dismissed = false;

  // Every selector passed here is part of the card template in mount(), so a miss is a bug.
  function $<E extends HTMLElement = HTMLElement>(s: string): E {
    const el = root?.querySelector<E>(s);
    if (!el) throw new Error(`Claude Overview: missing ${s}`);
    return el;
  }

  function mount(engine: Engine): void {
    const spot = findSpot(engine);
    document.getElementById("claude-overview-host")?.remove();
    const listTag = spot ? (spot.where === "before" ? spot.el.parentElement?.tagName : spot.el.tagName) : undefined;
    const parentIsList = listTag === "OL" || listTag === "UL";
    // An <li> can't hold a shadow root, so inside a results list wrap the card host in one.
    const card = document.createElement("div");
    const h = parentIsList ? document.createElement("li") : card;
    if (parentIsList) { h.style.listStyle = "none"; h.appendChild(card); }
    h.id = "claude-overview-host";
    host = h;
    // Closed, so the page's own scripts can't reach in to read the card or click its buttons.
    root = card.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${CSS}</style>
      <section class="card" aria-live="polite">
        <div class="head">${ICON.mark}<div class="model"></div>
          <button class="btn regen" title="Regenerate" aria-label="Regenerate">${ICON.regen}</button>
          <button class="btn close" title="Hide" aria-label="Hide">${ICON.close}</button></div>
        <div class="body"><div class="text"></div></div>
        <button class="more" hidden aria-expanded="false">Show more ${ICON.chev}</button>
        <div class="sources" hidden></div>
        <div class="foot"><span class="grow"></span><span>Can make mistakes. Check the sources.</span></div>
      </section>`;

    if (spot) {
      if (spot.where === "prepend") spot.el.prepend(h); else spot.el.before(h);
      if (engine.maxWidth) h.style.maxWidth = engine.maxWidth;
      adoptTheme(card, spot.where === "prepend" ? spot.el : spot.el.parentElement ?? spot.el);
    } else {
      Object.assign(h.style, { position: "fixed", top: "96px", right: "24px", width: "380px", zIndex: "2147483646" });
      document.body.appendChild(h);
      adoptTheme(card, document.body);
      $(".card").style.background = "var(--page-bg)";
      $(".card").style.boxShadow = "0 0 0 1px var(--line), 0 8px 30px rgba(0,0,0,.12)";
    }

    $(".close").onclick = () => { dismissed = true; port?.disconnect(); h.remove(); };
    // Regenerating costs money; only act on real clicks, not ones a page script dispatched.
    $(".regen").onclick = (e) => { if (e.isTrusted) void run(true); };
    $(".more").onclick = () => {
      const open = !$(".body").classList.toggle("clamped");
      const more = $(".more");
      more.setAttribute("aria-expanded", String(open));
      if (more.firstChild) more.firstChild.textContent = open ? "Show less " : "Show more ";
    };
  }

  function setModel(id: string): void {
    if (root) $(".model").textContent = modelLabel(id);
    if (state) state.model = id;
  }

  function paintText(streaming: boolean): void {
    if (!state?.text) return;
    $(".text").innerHTML = render(state.text, state.sources) + (streaming ? `<span class="caret"></span>` : "");
    const body = $(".body");
    const tall = $(".text").scrollHeight > 260; // only collapse when a good chunk would be hidden
    if (tall && !body.dataset["touched"]) { body.classList.add("clamped"); body.dataset["touched"] = "1"; }
    $(".more").hidden = !tall;
  }

  function paintSources(): void {
    if (!state) return;
    const box = $(".sources");
    box.hidden = !state.sources.length;
    // Sources may come back from the cache, so their URLs are checked again here, not just when scraped.
    box.innerHTML = state.sources.map((s, i) => {
      const href = safeHttpUrl(s.url);
      const icon = s.icon && safeHttpUrl(s.icon);
      if (!href) return "";
      return `
      <a class="src" href="${esc(href)}" title="${esc(s.title)}" target="_blank" rel="noopener">
        ${icon ? `<img src="${esc(icon)}" alt="" referrerpolicy="no-referrer">` : `<span class="ph">${esc(s.host.charAt(0).toUpperCase())}</span>`}
        <span class="h">${esc(s.host)}</span><span class="n">${i + 1}</span></a>`;
    }).join("");
    box.querySelectorAll("img").forEach((img) => img.addEventListener("error", () => {
      const ph = document.createElement("span"); ph.className = "ph";
      ph.textContent = img.closest(".src")?.querySelector(".h")?.textContent?.charAt(0).toUpperCase() ?? "";
      img.replaceWith(ph);
    }));
  }

  function paintAll(): void {
    if (!state) return;
    setModel(state.model);
    paintSources();
    if (state.error) showNote(state.error);
    else if (state.text) paintText(!state.done);
    else skeleton();
  }

  function skeleton(): void {
    $(".text").innerHTML = `<div class="skeleton"><span></span><span></span><span></span></div>`;
    $(".more").hidden = true;
  }

  // `html` must already be escaped; callers build it from fixed strings and esc().
  function showNote(html: string): void {
    $(".text").innerHTML = `<p class="note">${html}</p>`;
    root?.querySelector(".text .open-opts")?.addEventListener("click", openOptions);
  }

  async function run(force = false): Promise<void> {
    const cur = current();
    if (!cur) return;
    dismissed = false;
    port?.disconnect();
    const { model } = await requestPageSettings();

    // Wait until the results (and so our mount point) exist before drawing anything.
    await waitFor(() => findSpot(cur.engine));
    if (!host?.isConnected) mount(cur.engine);
    const body = $(".body");
    body.classList.remove("clamped"); delete body.dataset["touched"];

    const st: State = { text: "", sources: [], query: cur.query, model, done: false, error: "" };
    state = st;
    setModel(st.model);
    skeleton();
    st.sources = (await waitFor(() => { const s = scrapeSources(); return s.length >= 3 ? s : null; }, 2000)) ?? scrapeSources();
    if (state !== st) return; // a newer search started while we waited
    paintSources();

    const p = chrome.runtime.connect({ name: "overview" });
    port = p;
    p.onMessage.addListener((m: OverviewEvent) => {
      if (state !== st) return;
      switch (m.type) {
        case "model":
          setModel(m.model);
          break;
        case "delta":
          st.text += m.text; paintText(true);
          break;
        case "cached":
          Object.assign(st, { text: m.text, sources: m.sources, done: true });
          setModel(m.model); paintSources(); paintText(false);
          break;
        case "done":
          st.done = true; paintText(false);
          break;
        case "error":
          st.error = m.code === "nokey"
            ? `Add an Anthropic API key to turn this on. <a class="open-opts">Open settings</a>`
            : `Couldn’t generate an answer: ${esc(m.message)}. Use regenerate to try again.`;
          showNote(st.error);
          break;
      }
    });
    const start: StartMessage = { type: "start", engine: cur.engine.id, query: cur.query, sources: st.sources, force };
    p.postMessage(start);
  }

  async function showClickToGenerate(): Promise<void> {
    const cur = current();
    if (!cur) return;
    const { model } = await requestPageSettings();
    await waitFor(() => findSpot(cur.engine));
    mount(cur.engine);
    setModel(model);
    showNote("Ask for a short answer to this search, with sources.");
    $(".foot").insertAdjacentHTML("afterbegin", `<button class="go">Generate answer</button>`);
    const go = $(".go");
    go.onclick = (e) => { if (!e.isTrusted) return; go.remove(); void run(); };
  }

  async function start(): Promise<void> {
    if (!current()) return;
    const { mode } = await requestPageSettings();
    if (mode === "click") await showClickToGenerate(); else await run();
  }

  // Watch for new searches without a reload, and for the page re-rendering our card away.
  let lastKey = "";
  setInterval(() => {
    const cur = current();
    const key = cur ? cur.engine.id + "|" + cur.query : "";
    if (key && key !== lastKey) { lastKey = key; state = null; host?.remove(); void start(); return; }
    if (cur && state && !dismissed && host && !host.isConnected && findSpot(cur.engine)) {
      mount(cur.engine); paintAll();
    }
  }, 800);
  const first = current();
  if (first) { lastKey = first.engine.id + "|" + first.query; void start(); }
})();
