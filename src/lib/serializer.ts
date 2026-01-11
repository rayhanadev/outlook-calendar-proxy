import { DEFAULT_TIMEZONE } from './constants';
import { normalizeTimezone, sortEvents } from './normalize';
import type { NormalizedCalendar } from './types';

export function foldLine(line: string): string {
	if (line.length <= 75) return line;

	const result: string[] = [];
	let remaining = line;

	result.push(remaining.substring(0, 75));
	remaining = remaining.substring(75);

	while (remaining.length > 0) {
		const chunk = remaining.substring(0, 74);
		result.push(' ' + chunk);
		remaining = remaining.substring(74);
	}

	return result.join('\r\n');
}

export function generateVtimezone(tzid: string): string {
	if (tzid === 'America/Indiana/Indianapolis' || tzid === 'America/New_York') {
		return `BEGIN:VTIMEZONE
TZID:${tzid}
BEGIN:STANDARD
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
END:DAYLIGHT
END:VTIMEZONE`;
	}

	if (tzid === 'America/Chicago') {
		return `BEGIN:VTIMEZONE
TZID:America/Chicago
BEGIN:STANDARD
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZOFFSETFROM:-0500
TZOFFSETTO:-0600
TZNAME:CST
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZOFFSETFROM:-0600
TZOFFSETTO:-0500
TZNAME:CDT
END:DAYLIGHT
END:VTIMEZONE`;
	}

	if (tzid === 'America/Los_Angeles') {
		return `BEGIN:VTIMEZONE
TZID:America/Los_Angeles
BEGIN:STANDARD
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
TZNAME:PST
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
TZNAME:PDT
END:DAYLIGHT
END:VTIMEZONE`;
	}

	return `BEGIN:VTIMEZONE
TZID:${tzid}
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0000
TZOFFSETTO:+0000
TZNAME:${tzid}
END:STANDARD
END:VTIMEZONE`;
}

export function serializeCalendar(parsed: NormalizedCalendar, defaultTz?: string): string {
	const tz = defaultTz || DEFAULT_TIMEZONE;
	const output: string[] = [];

	for (const line of parsed.headerLines) {
		output.push(line);
	}

	if (!parsed.timezoneBlocks.some((tzBlock) => tzBlock.includes(`TZID:${tz}`))) {
		output.push(generateVtimezone(tz));
	}

	for (const tzBlock of parsed.timezoneBlocks) {
		const tzidMatch = tzBlock.match(/TZID:([^\r\n]+)/);
		if (tzidMatch) {
			const tzid = normalizeTimezone(tzidMatch[1]);
			if (tzid !== tzidMatch[1]) {
				output.push(tzBlock.replace(tzidMatch[1], tzid));
			} else {
				output.push(tzBlock);
			}
		} else {
			output.push(tzBlock);
		}
	}

	const sortedEvents = sortEvents(parsed.normalizedEvents);

	for (const event of sortedEvents) {
		for (const line of event.lines) {
			output.push(foldLine(line));
		}
	}

	for (const line of parsed.footerLines) {
		output.push(line);
	}

	return output.join('\r\n');
}
