# Smaac language routing

Cloudflare preview for language-neutral routes on smaac.nl. The live website and DNS are not connected to this preview.

Preview: https://smaac-language-router-preview.spring-star-e2fc.workers.dev/

- `worker.mjs`: cookie/browser language selection; explicit `/nl` and `/en` URLs bypass routing.
- `sync.py`: generates all routes from the live Webflow sitemap and reciprocal hreflang links; no manual content-route list.
- `routes.json` / `routes.csv`: initial generated snapshot, 548 localized paths and 284 neutral aliases (275 eligible after technical bypasses).
- `wrangler.jsonc`: preview only, `DRY_RUN=true`, no custom domains or routes.
- `locale-preference.js`: optional Webflow locale-switcher cookie proposal; not installed.

## Automatic refresh

The workflow in `.github/workflows/sync-language-routes.yml` rebuilds and validates the manifest every hour, then replaces the preview KV value `routes:current`. It does not deploy Worker code or change DNS. Configure the repository Actions secret `CF_API_TOKEN` with the required Cloudflare KV write permission before running it. Account and namespace IDs in the workflow are identifiers, not credentials.

Failure before upload preserves the existing KV snapshot. Unknown/ambiguous language relationships fail validation. KV updates are eventually consistent. GitHub schedules may be delayed and scheduled workflows in public repositories can be disabled after repository inactivity; monitor failures and the manifest timestamp.

## Local checks

```sh
python3 sync.py --output routes.json
python3 test-sync.py
node test-worker.mjs
```

Publishing a fresh manifest requires `CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID`, and `CF_API_TOKEN` in the environment, then `python3 sync.py --publish`.

## Scope

Known language variants are paired by published hreflang relationships, including translated slugs. Each localized variant contributes a neutral alias after stripping its first locale segment. Singleton pages fall back to their available language. Existing Webflow redirects handle legacy URLs; arbitrary historic marketing aliases cannot be inferred from a sitemap alone.

Production activation requires a separate reviewed change. Do not set `DRY_RUN=false` or attach smaac.nl routes as part of preview setup.
