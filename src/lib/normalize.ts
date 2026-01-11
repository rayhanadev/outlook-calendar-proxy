import { DEFAULT_TIMEZONE, MS_TO_IANA_TIMEZONES, PROPERTY_ORDER } from './constants';
import { getProperty } from './parser';
import type { IcsEvent, IcsProperty, NormalizedEvent } from './types';

export function normalizeTimezone(tzid: string): string {
	return MS_TO_IANA_TIMEZONES[tzid] || tzid;
}

export function parseDateTimeValue(value: string): { date: string; time: string; isUtc: boolean; isDateOnly: boolean } {
	const isUtc = value.endsWith('Z');
	const cleanValue = isUtc ? value.slice(0, -1) : value;

	if (cleanValue.includes('T')) {
		const [date, time] = cleanValue.split('T');
		return { date, time, isUtc, isDateOnly: false };
	}

	return { date: cleanValue, time: '', isUtc: false, isDateOnly: true };
}

export function normalizeDateTimeProp(prop: IcsProperty, defaultTz: string): string {
	const { date, time, isUtc, isDateOnly } = parseDateTimeValue(prop.value);

	if (isDateOnly) {
		return `${prop.name};VALUE=DATE:${date}`;
	}

	if (isUtc) {
		return `${prop.name}:${date}T${time}Z`;
	}

	let tzid = prop.params.get('TZID') || defaultTz;
	tzid = normalizeTimezone(tzid);

	return `${prop.name};TZID=${tzid}:${date}T${time}`;
}

export function normalizeExdateRdate(prop: IcsProperty): string {
	const values = prop.value.split(',');
	const normalized: string[] = [];
	let tzid = prop.params.get('TZID');
	if (tzid) tzid = normalizeTimezone(tzid);

	for (const val of values) {
		const { date, time, isUtc, isDateOnly } = parseDateTimeValue(val.trim());
		if (isDateOnly) {
			normalized.push(date);
		} else if (isUtc) {
			normalized.push(`${date}T${time}Z`);
		} else {
			normalized.push(`${date}T${time}`);
		}
	}

	normalized.sort();

	const isDateOnlyResult = normalized[0] && !normalized[0].includes('T');
	if (isDateOnlyResult) {
		return `${prop.name};VALUE=DATE:${normalized.join(',')}`;
	}

	if (tzid) {
		return `${prop.name};TZID=${tzid}:${normalized.join(',')}`;
	}

	return `${prop.name}:${normalized.join(',')}`;
}

// BYSETPOS with single BYDAY can often be rewritten
// e.g., BYDAY=MO;BYSETPOS=1 → BYDAY=1MO
export function normalizeRrule(prop: IcsProperty): string {
	let value = prop.value;

	const bysetposMatch = value.match(/BYSETPOS=(-?\d+)/);
	const bydayMatch = value.match(/BYDAY=([A-Z]{2})/);

	if (bysetposMatch && bydayMatch && !value.match(/BYDAY=[^;]*,/)) {
		const pos = bysetposMatch[1];
		const day = bydayMatch[1];
		value = value.replace(/;?BYSETPOS=-?\d+/, '');
		value = value.replace(/BYDAY=[A-Z]{2}/, `BYDAY=${pos}${day}`);
	}

	return `RRULE:${value}`;
}

export function normalizeRecurrenceId(prop: IcsProperty, defaultTz: string): string {
	const { date, time, isUtc, isDateOnly } = parseDateTimeValue(prop.value);

	if (isDateOnly) {
		return `RECURRENCE-ID;VALUE=DATE:${date}`;
	}

	if (isUtc) {
		return `RECURRENCE-ID:${date}T${time}Z`;
	}

	let tzid = prop.params.get('TZID') || defaultTz;
	tzid = normalizeTimezone(tzid);

	return `RECURRENCE-ID;TZID=${tzid}:${date}T${time}`;
}

export function reconstructProperty(prop: IcsProperty): string {
	let result = prop.name;
	const sortedParams = Array.from(prop.params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
	for (const [key, value] of sortedParams) {
		result += `;${key}=${value}`;
	}
	result += `:${prop.value}`;
	return result;
}

export function normalizeProperty(prop: IcsProperty, defaultTz: string): string | null {
	switch (prop.name) {
		case 'DTSTART':
		case 'DTEND':
			return normalizeDateTimeProp(prop, defaultTz);
		case 'RECURRENCE-ID':
			return normalizeRecurrenceId(prop, defaultTz);
		case 'RRULE':
			return normalizeRrule(prop);
		case 'EXDATE':
		case 'RDATE':
			return normalizeExdateRdate(prop);
		case 'DTSTAMP':
		case 'CREATED':
		case 'LAST-MODIFIED':
			return normalizeDateTimeProp(prop, 'UTC');
		default:
			return reconstructProperty(prop);
	}
}

export function normalizeEventLines(
	event: IcsEvent,
	stableUid: string,
	sequence: number,
	defaultTz?: string,
): string[] {
	const tz = defaultTz || DEFAULT_TIMEZONE;
	const lines: string[] = ['BEGIN:VEVENT'];

	lines.push(`UID:${stableUid}@calproxy`);
	lines.push(`SEQUENCE:${sequence}`);

	const emittedProps = new Set(['UID', 'SEQUENCE']);
	const propsByName = new Map<string, IcsProperty[]>();

	for (const prop of event.properties) {
		if (!propsByName.has(prop.name)) {
			propsByName.set(prop.name, []);
		}
		propsByName.get(prop.name)!.push(prop);
	}

	for (const propName of PROPERTY_ORDER) {
		const props = propsByName.get(propName);
		if (!props) continue;
		emittedProps.add(propName);

		for (const prop of props) {
			const line = normalizeProperty(prop, tz);
			if (line) lines.push(line);
		}
	}

	for (const [propName, props] of propsByName) {
		if (emittedProps.has(propName)) continue;
		if (propName === 'BEGIN' || propName === 'END') continue;

		for (const prop of props) {
			lines.push(reconstructProperty(prop));
		}
	}

	lines.push('END:VEVENT');
	return lines;
}

export async function computeStableUid(event: IcsEvent): Promise<string> {
	const dtstart = getProperty(event, 'DTSTART');
	const summary = getProperty(event, 'SUMMARY');
	const organizer = getProperty(event, 'ORGANIZER');

	const components = [dtstart?.value || '', summary?.value || '', organizer?.value || '', event.uid].join('|');

	const encoder = new TextEncoder();
	const data = encoder.encode(components);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray
		.slice(0, 16)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export async function computeContentHash(event: IcsEvent): Promise<string> {
	const stableProps = event.properties
		.filter((p) => !['DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE'].includes(p.name))
		.map((p) => `${p.name}:${p.value}`)
		.sort()
		.join('\n');

	const encoder = new TextEncoder();
	const data = encoder.encode(stableProps);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createCancelledEventLines(stableUid: string, sequence: number, recurrenceId: string | null): string[] {
	const now = new Date();
	const dtstamp =
		now.getUTCFullYear().toString() +
		(now.getUTCMonth() + 1).toString().padStart(2, '0') +
		now.getUTCDate().toString().padStart(2, '0') +
		'T' +
		now.getUTCHours().toString().padStart(2, '0') +
		now.getUTCMinutes().toString().padStart(2, '0') +
		now.getUTCSeconds().toString().padStart(2, '0') +
		'Z';

	const lines = [
		'BEGIN:VEVENT',
		`UID:${stableUid}@calproxy`,
		`SEQUENCE:${sequence}`,
		`DTSTAMP:${dtstamp}`,
		'STATUS:CANCELLED',
	];

	if (recurrenceId) {
		lines.push(`RECURRENCE-ID:${recurrenceId}`);
		lines.push(`DTSTART:${recurrenceId}`);
	} else {
		lines.push(`DTSTART:${dtstamp}`);
	}

	lines.push('SUMMARY:Cancelled Event');
	lines.push('END:VEVENT');

	return lines;
}

export function sortEvents(events: NormalizedEvent[]): NormalizedEvent[] {
	const masters: NormalizedEvent[] = [];
	const exceptions: NormalizedEvent[] = [];

	for (const event of events) {
		if (event.isException) {
			exceptions.push(event);
		} else {
			masters.push(event);
		}
	}

	masters.sort((a, b) => a.stableUid.localeCompare(b.stableUid));
	exceptions.sort((a, b) => {
		const uidCmp = a.stableUid.localeCompare(b.stableUid);
		if (uidCmp !== 0) return uidCmp;
		return (a.recurrenceId || '').localeCompare(b.recurrenceId || '');
	});

	return [...masters, ...exceptions];
}
