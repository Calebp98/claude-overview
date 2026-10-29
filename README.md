# Claude Overview (for Helium or any Chromium browser)

A short answer card above your search results, written by Claude and labelled with the model that wrote it. It borrows the font and text colour of the results page, so it fits light and dark themes.
Works on Google, DuckDuckGo, Bing, Brave Search and Kagi.

## Install in Helium
1. Put this folder somewhere permanent, then run `npm install` and `npm run build` in it.
2. Go to `helium://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `claude-overview/dist` folder.
4. Click the extension's toolbar icon, paste your Anthropic API key, and save.
5. Search for something.

## Development
The source is strict TypeScript in `src/`; `static/` holds the manifest, settings page and icons.
- `npm run build` type-checks, then bundles into `dist/`. It refuses to build if the types don't check.
- `npm test` builds, then runs `tests/` against the built background worker with a fake browser and API.
- `npm run watch` rebuilds on save (no type-check; run `npm run typecheck` alongside it).
After a rebuild, click reload on the extension in `helium://extensions`.

## How it works
- `src/content.ts` reads the query from the results URL, scrapes the top result titles/URLs/snippets,
  and draws the card in a Shadow DOM so the search page's CSS can't break it.
- `src/background.ts` calls the Messages API through the official Anthropic SDK with streaming and relays text back; answers are cached
  per query for the browser session, so back/forward doesn't re-bill you. ↻ forces a fresh one.
- Citations like [2] link to the matching result.
- The settings page has a **Usage** section: cost today, over the last 30 days and all time, plus
  a per-model breakdown. Costs are estimated from the token counts the API returns, using the
  `PRICES` table in `src/background.ts`; update it if prices change.

## Notes
- Your key lives in `chrome.storage.local` on this machine and is only sent to api.anthropic.com.
  That storage is locked to the extension's own pages; the script running in search pages can't read it.
- To limit what a web page can cost you, overviews pause after 10 in a minute or 300 in 24 hours
  (`RATE` in `src/background.ts`). Answers served from the cache don't count.
- Search results are untrusted: the prompt marks them as data, and the card only ever links to http(s)
  URLs taken from the results page.
- Search engines change their markup; if the card shows up floating on the right instead of
  inline, update the `mounts` selectors for that engine in `src/content.ts`.
- To add another Google country domain, add it to `matches` in `static/manifest.json`.
- The messages passed between the content script and the background worker are typed in
  `src/shared.ts`, and the background checks each incoming request's shape before acting on it.
