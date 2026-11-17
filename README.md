# IPTV Web

Pull channels and guide data from Xtream Codes providers, clean them up into your own lineup, and serve that lineup as M3U, XMLTV and JSON. Everything the UI does goes through a REST API, so an agent can do the cleanup for you. Sports and PPV events are tracked as their own records.

Built with TanStack Start, React, shadcn/ui, Hono and zod-openapi, Drizzle, Cloudflare D1 and R2.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars        # set ADMIN_PASSWORD and SESSION_SECRET
npm run db:migrate:local
npm run dev                           # http://localhost:3000
```

### Deploying to Cloudflare

```bash
npx wrangler d1 create iptv-web       # paste database_id into wrangler.jsonc
npx wrangler r2 bucket create iptv-web
npm run db:migrate
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npm run deploy
```

Options in `wrangler.jsonc`:

- `PUBLIC_URL`: the base URL used in M3U and EPG links. Leave it empty to use the request's host.
- `EPG_DAYS`: how many days of guide data to keep (default 3).
- `DEFAULT_TIMEZONE`: the timezone for event times in M3U names and for parsing dates in event rules.
- `limits.cpu_ms: 300000`: syncing large providers and EPG files needs this, and it requires Workers Paid. On Workers Free, remove it (Free allows only 10 ms of CPU per request, which isn't enough to sync a real provider).
- Cron jobs: a full refresh (sources, then EPG, then event rules) every 6 hours, plus an event-rule pass every 30 minutes.
- An optional `API_TOKEN` secret works as a static admin bearer token.

## How it works

| Concept | What it is |
|---|---|
| Source | An Xtream provider. A sync stores its live channels as *source channels* (raw and read-only). |
| EPG source | An XMLTV feed. Each Xtream source gets one automatically, and you can add external ones. It's parsed as a stream, so files of hundreds of MB are fine. Programmes are only stored for channels mapped into the lineup. |
| Lineup | Categories, and the channels inside them. Each channel has a name, number, logo, an EPG mapping, and one or more upstream streams (later ones are backups). |
| Event | A title, start and end times, sport and league, and one or more linked lineup channels. You can create events by hand, or let rules create them. |
| Event rule | A regex. It runs against upstream channel names (e.g. `PPV 03: UFC 310 \| 12/07 10PM ET`, with the date parsed out) or against EPG programme titles (e.g. `NFL: Bears at Packers`). Rules can also create "event" channels that stay hidden while nothing is on. |

## Outputs

These need an output-scope token. Create one under Settings → API tokens.

- `/playlist.m3u?token=…`: includes an `Events` group with `x-event-*` attributes. Use `events=none` to drop it or `events=only` to get just events, and `tz=` to set the timezone for event times.
- `/epg.xml?token=…` and `/epg.xml.gz`: the cleaned guide. Event channels get programmes generated from their events. The file is cached in R2.
- `/api/output/lineup.json` and `/api/output/events.json`: for downstream apps.
- `/stream/<channelId>.ts`: redirects to the first working upstream stream, so provider credentials never appear in the playlist.

## MCP server

`/mcp` is a stateless Streamable HTTP MCP server with 32 tools covering lineup cleanup, EPG mapping, events and rules. Authenticate with an admin token.

Claude Code:

```bash
claude mcp add --transport http iptv https://<your-worker>/mcp --header "Authorization: Bearer <admin token>"
```

Claude Desktop and other clients that take JSON config:

```json
{ "mcpServers": { "iptv": { "type": "http", "url": "https://<your-worker>/mcp", "headers": { "Authorization": "Bearer <admin token>" } } } }
```

The tools call the REST API internally, so they behave exactly like the endpoints below. Adding or editing sources (credentials) is left to the UI on purpose.

## API for agents

- Guide: `GET /api/guide` (markdown, written for agents)
- OpenAPI 3.1: `GET /api/openapi.json`. Swagger UI is at `/api/docs`.
- Auth: send `Authorization: Bearer <admin token>`.

Useful endpoints for cleanup: `POST /lineup/channels/from-source`, `PATCH /lineup/channels` (bulk), `POST /lineup/channels/rename` (regex, with `dryRun`), `/clean-names`, `/merge`, `/renumber`, `/lineup/auto-map-epg`, `/event-rules/preview`, and `/lineup/export` / `/lineup/import` for backups.

## Tests

```bash
npm test
```
