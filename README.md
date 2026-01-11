# Normical

A hosted service that normalizes Microsoft Outlook ICS feeds for reliable Google Calendar sync. Fixes timezone issues, UID instability, and other incompatibilities that cause events to silently fail when importing Microsoft calendars into Google.

## The Problem

When you subscribe to a Microsoft Outlook/Exchange calendar from Google Calendar, several issues occur:

- **Events silently disappear** - Google rejects events with Microsoft's non-standard timezone names
- **Times are wrong** - Floating times (no timezone) are interpreted as UTC instead of local time
- **Updates are ignored** - Google caches aggressively and ignores changes without proper SEQUENCE bumps
- **Deletions don't sync** - Microsoft removes events from the feed instead of marking them cancelled
- **UIDs change** - Outlook regenerates UIDs on edits, causing Google to create duplicates

## Usage

1. Visit [normical.com](https://normical.com)
2. Paste your Outlook ICS calendar URL
3. Click "Generate proxy URL"
4. Copy the generated proxy URL
5. Add the proxy URL to Google Calendar (instead of the original Outlook URL)

To delete your calendar data, append `?delete=1` to your proxy URL.

## Self-Hosting

### Prerequisites

- [Bun](https://bun.sh) installed
- Cloudflare account with Workers enabled

### Steps

1. Clone the repository and install dependencies:

```bash
bun install
```

2. Create a KV namespace for state storage:

```bash
bunx wrangler kv namespace create CALENDAR_STATE
```

3. Update `wrangler.jsonc` with your KV namespace ID:

```jsonc
{
	"kv_namespaces": [
		{
			"binding": "CALENDAR_STATE",
			"id": "YOUR_KV_NAMESPACE_ID",
		},
	],
}
```

4. Deploy:

```bash
bunx wrangler deploy
```

6. Users can now visit your worker URL to register their calendars via the web UI.

## Local Development

```bash
bunx wrangler dev
```

Then access `http://localhost:8787` to test the service.

## API Endpoints

| Endpoint                        | Method | Description                                         |
| ------------------------------- | ------ | --------------------------------------------------- |
| `/`                             | GET    | Web UI for registering calendars                    |
| `/register`                     | POST   | Register a calendar (JSON body: `{ "url": "..." }`) |
| `/{hash}/calendar.ics`          | GET    | Returns the normalized ICS calendar                 |
| `/{hash}/calendar.ics?delete=1` | GET    | Deletes all stored data for this calendar           |
| `/health`                       | GET    | Health check endpoint                               |

## Microsoft to Google Calendar Discrepancies

This section documents the specific incompatibilities between Microsoft Outlook ICS exports and Google Calendar imports that Normical addresses.

### 1. Timezone Name Incompatibility

**Problem**: Microsoft uses Windows timezone names (e.g., `US Eastern Standard Time`, `Eastern Standard Time`) which Google Calendar doesn't recognize, causing events to be silently dropped.

**Solution**: Normical maps all Microsoft timezone names to IANA standard identifiers:

| Microsoft Name             | IANA Identifier                |
| -------------------------- | ------------------------------ |
| `US Eastern Standard Time` | `America/Indiana/Indianapolis` |
| `Eastern Standard Time`    | `America/New_York`             |
| `Central Standard Time`    | `America/Chicago`              |
| `Pacific Standard Time`    | `America/Los_Angeles`          |
| ...                        | (20+ mappings supported)       |

### 2. Floating Times

**Problem**: Outlook emits datetime values without timezone information (floating times). Google interprets these as UTC, causing events to appear at wrong times.

**Solution**: Normical adds explicit `TZID` parameters to all floating datetime properties using the configured default timezone.

### 3. UID Instability

**Problem**: Microsoft Outlook regenerates UIDs when events are edited. Google treats UID as the event identity, so changed UIDs create duplicate events.

**Solution**: Normical generates stable synthetic UIDs by hashing immutable event properties:

```
UID = SHA256(DTSTART + SUMMARY + ORGANIZER + original_uid)
```

### 4. Silent Deletions

**Problem**: When events are deleted in Outlook, they simply disappear from the ICS feed. Google never removes events that go missing - it assumes they're just not in the current view.

**Solution**: Normical maintains a KV-backed registry of seen events. When an event disappears, it emits a `STATUS:CANCELLED` event to explicitly delete it from Google.

### 5. Ignored Updates

**Problem**: Google aggressively caches ICS feeds and ignores content changes if the `SEQUENCE` number hasn't incremented.

**Solution**: Normical:

- Tracks content hashes for each event in KV storage
- Automatically increments `SEQUENCE` when event content changes
- Sets `Cache-Control: no-store` headers
- Generates synthetic ETags from content hashes

### 6. RRULE Incompatibilities

**Problem**: Microsoft emits RRULE (recurrence rule) combinations that Google doesn't support, such as `BYDAY=MO;BYSETPOS=1`.

**Solution**: Normical rewrites unsupported RRULE patterns to Google-compatible equivalents:

```
BYDAY=MO;BYSETPOS=1 → BYDAY=1MO
```

### 7. Event Ordering

**Problem**: Google requires parent recurring events to appear before their exceptions (events with `RECURRENCE-ID`). Microsoft doesn't guarantee this order.

**Solution**: Normical sorts all events: master events first (sorted by UID), then exceptions (sorted by UID and RECURRENCE-ID).

### 8. VTIMEZONE Definitions

**Problem**: Microsoft includes VTIMEZONE blocks with Windows timezone names that Google doesn't recognize.

**Solution**: Normical:

- Normalizes existing VTIMEZONE block identifiers to IANA names
- Injects proper VTIMEZONE definitions with correct DST rules for the default timezone

### 9. ETag/Caching Issues

**Problem**: Microsoft sometimes reuses ETags even when content changes. Google's aggressive caching (12-24 hours) means changes don't propagate.

**Solution**: Normical generates its own ETags from a SHA-256 hash of the normalized output, ensuring any content change produces a new ETag.

### 10. Empty Feed Protection

**Problem**: If Microsoft temporarily returns an empty feed (due to auth issues or service problems), Google would delete all events.

**Solution**: Normical maintains a "last known good" snapshot in KV storage. If the upstream feed is empty or returns an error, it serves the cached snapshot instead.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Google         │     │    Normical     │     │  Microsoft      │
│  Calendar       │────▶│  (CF Worker)    │────▶│  Outlook        │
│                 │◀────│                 │◀────│                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │  Cloudflare KV  │
                        │  (State Store)  │
                        └─────────────────┘
```

Each registered calendar gets a unique hash-based URL. State is stored per-tenant in KV, enabling multi-user support without configuration.

## License

MIT
