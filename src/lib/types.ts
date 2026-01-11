export interface IcsProperty {
	name: string;
	params: Map<string, string>;
	value: string;
}

export interface IcsEvent {
	uid: string;
	properties: IcsProperty[];
	rawLines: string[];
}

export interface ParsedCalendar {
	headerLines: string[];
	timezoneBlocks: string[];
	events: IcsEvent[];
	footerLines: string[];
}

export interface NormalizedEvent {
	stableUid: string;
	sequence: number;
	isException: boolean;
	recurrenceId: string | null;
	lines: string[];
}

export interface NormalizedCalendar extends ParsedCalendar {
	normalizedEvents: NormalizedEvent[];
}

export interface EventState {
	sequence: number;
	contentHash: string;
	lastSeen: number;
}

export interface CalendarSnapshot {
	eventKeys: string[];
	generatedAt: number;
}
