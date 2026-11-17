export const AGENT_GUIDE = `# IPTV Web — agent guide

Base URL: {{BASE}}/api  ·  OpenAPI: {{BASE}}/api/openapi.json  ·  Swagger UI: {{BASE}}/api/docs
Auth: \`Authorization: Bearer <admin token>\` (create one in Settings → API tokens, or POST /api/tokens).

## Mental model
- **Sources** are Xtream Codes providers. Syncing pulls their live channels into **source channels**
  (id = \`<sourceId>:<streamId>\`). Source channels are raw and read-only.
- The **lineup** is the cleaned output: **categories** (M3U group-title) containing **lineup channels**.
  Each lineup channel has a name/number/logo/category, an optional EPG mapping
  (\`epgSourceId\` + \`epgChannelId\`), and one or more upstream **streams** in failover order.
- **EPG sources** are XMLTV feeds (each Xtream source gets one automatically, external ones can be added).
  Programmes are only stored for EPG channels that are mapped into the lineup → after changing mappings,
  call \`POST /api/epg/refresh\`.
- **Events** (sports, PPV…) have a title, times, sport/league and linked lineup channels. They come from
  manual creation or **event rules** (regex over upstream channel names or over EPG programme titles).
  Editing a rule-generated event locks it so rules stop touching it.
- Outputs: \`/playlist.m3u\`, \`/epg.xml\` (.gz), \`/api/output/lineup.json\`, \`/api/output/events.json\`.
  Players use an *output*-scope token via \`?token=\`.

## Typical cleanup workflow
1. \`GET /api/stats\` and \`GET /api/source-categories\` to see what's available.
2. Find channels: \`GET /api/source-channels?q=espn&inLineup=false\` (or \`regex=\`, \`categoryLike=\`).
3. Add them: \`POST /api/lineup/channels/from-source {"sourceChannelIds": [...], "categoryName": "Sports"}\`
   (names are auto-cleaned; provider EPG is auto-mapped when the stream has an epg_channel_id).
4. Fix names: \`PATCH /api/lineup/channels\` with \`{"updates":[{"id":"ch_…","name":"ESPN"}]}\`, or regex
   \`POST /api/lineup/channels/rename {"pattern":"\\\\s+HD$","replacement":"","dryRun":true}\`.
5. Dedupe: \`POST /api/lineup/channels/merge {"targetId":"ch_a","sourceIds":["ch_b"]}\` → ch_b's streams become backups.
6. Order: \`POST /api/lineup/categories/reorder\`, \`POST /api/lineup/channels/renumber {"categoryId":"…","start":100}\`.
7. EPG: \`GET /api/lineup/channels?hasEpg=false\`, then \`GET /api/lineup/channels/{id}/epg-suggestions\` or
   \`POST /api/lineup/auto-map-epg {"dryRun":true}\`; set with PATCH \`{"epgSourceId","epgChannelId"}\`;
   finish with \`POST /api/epg/refresh\`.
8. Health: \`GET /api/lineup/channels?brokenStreams=true\` lists channels whose upstream streams all vanished.

Always prefer \`dryRun: true\` first for rename / clean-names / auto-map-epg, and \`GET /api/lineup/export\`
before large destructive changes (restore with \`POST /api/lineup/import\`).

## Events
- PPV-style provider channels (e.g. "PPV 03: UFC 310 | Sat 12/07 10PM ET"):
  \`POST /api/event-rules/preview {"name":"PPV","kind":"source_channel","pattern":"^PPV\\\\s*\\\\d+\\\\s*[:|]\\\\s*(?<title>.+)","sport":"Combat"}\`
  iterate until matches look right, then \`POST /api/event-rules\` with \`autoAddChannel: true\` and a
  \`targetCategoryId\` to create hide-when-idle event channels automatically.
- Games found in the guide: \`kind: "epg_programme"\`, pattern like \`"^(NFL|NBA)\\\\b.*\\\\b(vs\\\\.?|at|@)\\\\b"\`,
  optionally limited with \`lineupCategoryIds\`.
- Manual: \`POST /api/events {"title","startsAt":"2026-12-07T22:00:00-05:00","sport","channels":[{"lineupChannelId":"ch_…","label":"Main"}]}\`.
- Event times are epoch ms in responses; inputs accept epoch ms or ISO-8601.
`
