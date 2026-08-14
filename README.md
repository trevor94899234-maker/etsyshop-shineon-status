# EtsyShop x ShineOn Operations Monitor

This repository contains the Track 3 crawler page for the EtsyShop personal-OS workflow. It keeps a saved snapshot rather than scraping a page in the browser.

## Published pages

- ShineOn system status: `https://trevor94899234-maker.github.io/etsyshop-shineon-status/`
- Product change monitor: `https://trevor94899234-maker.github.io/etsyshop-shineon-status/product-change-monitor/`

## Sources and source checks

The status page uses ShineOn's public API endpoints:

- [Summary API](https://status.shineon.com/v3/summary.json)
- [Components API](https://status.shineon.com/v3/components.json)
- [Public API documentation](https://status.shineon.com/en/public-api)
- [ShineOn source terms](https://status.shineon.com/en/terms)

The product extension additionally reads the supplied public sources:

- [Production and Sync Timescales](https://teamshineon.zendesk.com/hc/en-us/articles/10262194743441-Production-and-Sync-Timescales-Info)
- [Shipping Timescales and Prices](https://teamshineon.zendesk.com/hc/en-us/articles/10281047558545-Shipping-Timescales-Prices-Info#Variable)
- [ShineOn prices sheet](https://docs.google.com/spreadsheets/d/1RapLC3WTjaDLePDZszpRh8SzBj0SNzhiTtySueTOpvE/edit?gid=170660766#gid=170660766)

Source checks recorded on 2026-08-15 (HKT):

- `https://status.shineon.com/robots.txt` returned HTTP 404. No path-specific `Disallow` rule was exposed by that URL. This is an observation, not a permission grant.
- The public API documentation was checked for access requirements and a numeric rate limit. No numeric rate limit was shown on the checked page; the workflow therefore uses a conservative six-hour schedule and the published pages read only saved JSON.
- No API key, token, password, login, or personal email is required or stored.

## Saved data

The status fetcher writes `data/shineon-status.json` with `fetchedAt`, source URLs, the page status, and each component's original `name`, `status`, and `group`. `activeIncidents` and `activeMaintenances` are kept only when the API provides them; absent fields are not changed into zero.

The product fetcher writes `etsyshop-product-change-monitor/data/product-status.json`. It keeps the selected product costs, regional shipping prices and windows, production ranges, source URLs, and snapshot-to-snapshot change records.

Both scripts write a temporary file first and replace the previous snapshot only after all required source checks pass. A failed fetch exits with code 1 and leaves the previous data file intact.

## Run locally

From the repository root:

```text
node scripts/fetch-shineon-status.mjs
node etsyshop-product-change-monitor/scripts/fetch-etsyshop-product-data.mjs
python -m http.server 8787
```

Open `http://127.0.0.1:8787/` for the status page or `http://127.0.0.1:8787/product-change-monitor/` for the product page. A local HTTP server is required; opening the HTML file directly can block relative JSON requests.

## GitHub Actions and Pages

`.github/workflows/update-shineon-status.yml` runs the two fetchers every six hours and also exposes `workflow_dispatch` for a manual run. It commits changed snapshots and deploys both pages to GitHub Pages. A scheduled run is not treated as verified until GitHub shows a successful run; use the manual button for a repeatable acceptance check.

The Personal OS home/navigation must contain an entry to the published status page. The repository page also links to the product extension so both views remain discoverable.
