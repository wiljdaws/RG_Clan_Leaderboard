# Clan Clash Cup — Live Standings

Live clan leaderboard for the Rocket Goal Clan Clash Cup. Reads the same
Firestore project the ATLAS userscript writes to and renders clan standings
with per-member contributions, live via `onSnapshot`.

## Structure

```
index.html        page shell
css/clash.css     all styling (design tokens in :root)
js/config.js      Firebase config + collection names + SDK version
js/members.js     legacy-array/current-map member compatibility
js/scoring.js     ATLAS-identical event scoring (pure, importable)
js/render.js      DOM rendering
js/app.js         boot + Firestore listeners
js/live-state.js  snapshot readiness, clock, visibility lifecycle
js/history.js     event-scoped local archive and replay
js/demo-data.js   offline fallback sample data
```

## Scoring

Ported line-for-line from ATLAS (`computeClanEventScore`,
`clanBaselineForCurrentEvent`, `eventPhase`):

- Contribution = current MMR − member `eventBaseline`
- Legacy clan-level `eventBaseline[userId]` remains a fallback
- Newer `memberStats[userId]` wins over stale member MMR
- A clan only scores if its `eventId` matches `String(events/current.startTime)`
- Members without a locked baseline show "no baseline" and count zero
- Clan score = sum across all baselined members (negatives count)

When Clash standings get integrated into the main leaderboard site, import
`js/scoring.js` there instead of duplicating the math.

## Local history

The archive stores small event-scoped score snapshots in this browser only.
It does not write to Firebase and never feeds active event scoring. Use
“Clear this event” in the Archive tab to remove one saved event.

## Deploy

No build step. Push to a GitHub Pages branch (or drop into the existing
site repo as `/clash/`) and it's live. If the page falls back to demo mode
in production, check that Firestore rules allow unauthenticated reads on
`clans` and `events/current` (ATLAS already relies on this).

## Versioning

Whole-tenth versions only (13.4 → 13.5), matching the ATLAS convention.
