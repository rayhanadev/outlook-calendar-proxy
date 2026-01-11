# CalProxy

A Cloudflare Worker that acts as a calendar reconciliation engine between Microsoft Outlook ICS feeds and Google Calendar. It normalizes ICS data to fix timezone issues, UID instability, and other incompatibilities that cause events to silently fail when importing Microsoft calendars into Google.

## The Problem

When you subscribe to a Microsoft Outlook/Exchange calendar from Google Calendar, several issues occur:

- **Events silently disappear** - Google rejects events with Microsoft's non-standard timezone names
- **Times are wrong** - Floating times (no timezone) are interpreted as UTC instead of local time
- **Updates are ignored** - Google caches aggressively and ignores changes without proper SEQUENCE bumps
- **Deletions don't sync** - Microsoft removes events from the feed instead of marking them cancelled
- **UIDs change** - Outlook regenerates UIDs on edits, causing Google to create duplicates

## The Solution

CalProxy acts as middleware that:

1. Fetches your Outlook ICS feed
2. Normalizes it to be Google Calendar compatible
3. Serves a corrected ICS feed that Google can properly import

## Deployment

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

4. Configure environment variables in the [Cloudflare Dashboard](https://dash.cloudflare.com):
   - Go to **Workers & Pages** → Your Worker → **Settings** → **Variables**
   - Add the following environment variables:

   | Variable           | Required | Description                                                                      |
   | ------------------ | -------- | -------------------------------------------------------------------------------- |
   | `UPSTREAM_ICS_URL` | Yes      | The Microsoft Outlook ICS feed URL to proxy                                      |
   | `DEFAULT_TIMEZONE` | No       | IANA timezone for events without explicit timezone (default: `America/New_York`) |

   For local development, create a `.env.local` file:

   ```
   UPSTREAM_ICS_URL=https://outlook.office365.com/owa/calendar/...
   DEFAULT_TIMEZONE=America/New_York
   ```

5. Deploy:

```bash
bunx wrangler deploy
```

6. Add the worker URL to Google Calendar instead of the original Outlook URL.

## Environment Variables

| Variable           | Required | Description                                                                      |
| ------------------ | -------- | -------------------------------------------------------------------------------- |
| `UPSTREAM_ICS_URL` | Yes      | The Microsoft Outlook ICS feed URL to proxy                                      |
| `DEFAULT_TIMEZONE` | No       | IANA timezone for events without explicit timezone (default: `America/New_York`) |

## Local Development

```bash
bunx wrangler dev
```

Then access `http://localhost:8787` to test the proxy.

## API Endpoints

| Endpoint        | Description                         |
| --------------- | ----------------------------------- |
| `/`             | Returns the normalized ICS calendar |
| `/calendar.ics` | Same as `/`                         |
| `/health`       | Health check endpoint               |

## Microsoft → Google Calendar Discrepancies

This section documents the specific incompatibilities between Microsoft Outlook ICS exports and Google Calendar imports that CalProxy addresses.

### 1. Timezone Name Incompatibility

**Problem**: Microsoft uses Windows timezone names (e.g., `US Eastern Standard Time`, `Eastern Standard Time`) which Google Calendar doesn't recognize, causing events to be silently dropped.

**Solution**: CalProxy maps all Microsoft timezone names to IANA standard identifiers:

| Microsoft Name             | IANA Identifier                |
| -------------------------- | ------------------------------ |
| `US Eastern Standard Time` | `America/Indiana/Indianapolis` |
| `Eastern Standard Time`    | `America/New_York`             |
| `Central Standard Time`    | `America/Chicago`              |
| `Pacific Standard Time`    | `America/Los_Angeles`          |
| ...                        | (20+ mappings supported)       |

### 2. Floating Times

**Problem**: Outlook emits datetime values without timezone information (floating times). Google interprets these as UTC, causing events to appear at wrong times.

**Solution**: CalProxy adds explicit `TZID` parameters to all floating datetime properties using the configured default timezone.

### 3. UID Instability

**Problem**: Microsoft Outlook regenerates UIDs when events are edited. Google treats UID as the event identity, so changed UIDs create duplicate events.

**Solution**: CalProxy generates stable synthetic UIDs by hashing immutable event properties:

```
UID = SHA256(DTSTART + SUMMARY + ORGANIZER + original_uid)
```

### 4. Silent Deletions

**Problem**: When events are deleted in Outlook, they simply disappear from the ICS feed. Google never removes events that go missing - it assumes they're just not in the current view.

**Solution**: CalProxy maintains a KV-backed registry of seen events. When an event disappears, it emits a `STATUS:CANCELLED` event to explicitly delete it from Google.

### 5. Ignored Updates

**Problem**: Google aggressively caches ICS feeds and ignores content changes if the `SEQUENCE` number hasn't incremented.

**Solution**: CalProxy:

- Tracks content hashes for each event in KV storage
- Automatically increments `SEQUENCE` when event content changes
- Sets `Cache-Control: no-store` headers
- Generates synthetic ETags from content hashes

### 6. RRULE Incompatibilities

**Problem**: Microsoft emits RRULE (recurrence rule) combinations that Google doesn't support, such as `BYDAY=MO;BYSETPOS=1`.

**Solution**: CalProxy rewrites unsupported RRULE patterns to Google-compatible equivalents:

```
BYDAY=MO;BYSETPOS=1 → BYDAY=1MO
```

### 7. Event Ordering

**Problem**: Google requires parent recurring events to appear before their exceptions (events with `RECURRENCE-ID`). Microsoft doesn't guarantee this order.

**Solution**: CalProxy sorts all events: master events first (sorted by UID), then exceptions (sorted by UID and RECURRENCE-ID).

### 8. VTIMEZONE Definitions

**Problem**: Microsoft includes VTIMEZONE blocks with Windows timezone names that Google doesn't recognize.

**Solution**: CalProxy:

- Normalizes existing VTIMEZONE block identifiers to IANA names
- Injects proper VTIMEZONE definitions with correct DST rules for the default timezone

### 9. ETag/Caching Issues

**Problem**: Microsoft sometimes reuses ETags even when content changes. Google's aggressive caching (12-24 hours) means changes don't propagate.

**Solution**: CalProxy generates its own ETags from a SHA-256 hash of the normalized output, ensuring any content change produces a new ETag.

### 10. Empty Feed Protection

**Problem**: If Microsoft temporarily returns an empty feed (due to auth issues or service problems), Google would delete all events.

**Solution**: CalProxy maintains a "last known good" snapshot in KV storage. If the upstream feed is empty or returns an error, it serves the cached snapshot instead.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Google         │     │   CalProxy      │     │  Microsoft      │
│  Calendar       │────▶│   (CF Worker)   │────▶│  Outlook        │
│                 │◀────│                 │◀────│                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │  Cloudflare KV  │
                        │  (State Store)  │
                        └─────────────────┘
```

## License

MIT
