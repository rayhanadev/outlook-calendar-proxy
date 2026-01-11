import type { IcsEvent, IcsProperty, ParsedCalendar } from './types';

export function unfoldLines(ics: string): string[] {
	const rawLines = ics.split(/\r?\n/);
	const unfolded: string[] = [];

	for (const line of rawLines) {
		if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
			unfolded[unfolded.length - 1] += line.substring(1);
		} else {
			unfolded.push(line);
		}
	}

	return unfolded;
}

export function parseProperty(line: string): IcsProperty | null {
	const colonIdx = line.indexOf(':');
	if (colonIdx === -1) return null;

	const beforeColon = line.substring(0, colonIdx);
	const value = line.substring(colonIdx + 1);

	const semiIdx = beforeColon.indexOf(';');
	const name = semiIdx === -1 ? beforeColon : beforeColon.substring(0, semiIdx);
	const params = new Map<string, string>();

	if (semiIdx !== -1) {
		const paramStr = beforeColon.substring(semiIdx + 1);
		const paramParts = paramStr.split(';');
		for (const part of paramParts) {
			const eqIdx = part.indexOf('=');
			if (eqIdx !== -1) {
				params.set(part.substring(0, eqIdx).toUpperCase(), part.substring(eqIdx + 1));
			}
		}
	}

	return { name: name.toUpperCase(), params, value };
}

export function parseIcs(ics: string): ParsedCalendar {
	const lines = unfoldLines(ics);
	const headerLines: string[] = [];
	const timezoneBlocks: string[] = [];
	const events: IcsEvent[] = [];
	const footerLines: string[] = [];

	let inTimezone = false;
	let inEvent = false;
	let currentTimezoneLines: string[] = [];
	let currentEventLines: string[] = [];
	let currentEventProps: IcsProperty[] = [];
	let currentUid = '';
	let headerDone = false;

	for (const line of lines) {
		if (line === 'BEGIN:VTIMEZONE') {
			inTimezone = true;
			currentTimezoneLines = [line];
			continue;
		}

		if (inTimezone) {
			currentTimezoneLines.push(line);
			if (line === 'END:VTIMEZONE') {
				timezoneBlocks.push(currentTimezoneLines.join('\r\n'));
				inTimezone = false;
			}
			continue;
		}

		if (line === 'BEGIN:VEVENT') {
			headerDone = true;
			inEvent = true;
			currentEventLines = [line];
			currentEventProps = [];
			currentUid = '';
			continue;
		}

		if (inEvent) {
			currentEventLines.push(line);
			const prop = parseProperty(line);
			if (prop) {
				currentEventProps.push(prop);
				if (prop.name === 'UID') {
					currentUid = prop.value;
				}
			}
			if (line === 'END:VEVENT') {
				events.push({
					uid: currentUid,
					properties: currentEventProps,
					rawLines: currentEventLines,
				});
				inEvent = false;
			}
			continue;
		}

		if (!headerDone) {
			headerLines.push(line);
		} else if (line === 'END:VCALENDAR') {
			footerLines.push(line);
		}
	}

	return { headerLines, timezoneBlocks, events, footerLines };
}

export function getProperty(event: IcsEvent, name: string): IcsProperty | undefined {
	return event.properties.find((p) => p.name === name);
}
