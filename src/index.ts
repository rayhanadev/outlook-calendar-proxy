import {
	type EventState,
	type NormalizedCalendar,
	type NormalizedEvent,
	computeContentHash,
	computeEtag,
	computeStableUid,
	createCancelledEventLines,
	getEventState,
	getLastGoodSnapshot,
	getProperty,
	getPreviousSnapshot,
	normalizeEventLines,
	parseIcs,
	saveEventState,
	saveSnapshot,
	saveSnapshotKeys,
	serializeCalendar,
} from './lib';

interface Env {
	CALENDAR_STATE: KVNamespace;
	UPSTREAM_ICS_URL: string;
	DEFAULT_TIMEZONE?: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: corsHeaders(),
			});
		}

		if (!env.UPSTREAM_ICS_URL) {
			return new Response('UPSTREAM_ICS_URL environment variable not configured', { status: 500 });
		}

		if (url.pathname === '/health') {
			return new Response('OK', { status: 200 });
		}

		if (url.pathname !== '/' && url.pathname !== '/calendar.ics') {
			return new Response('Not Found', { status: 404 });
		}

		try {
			const response = await fetch(env.UPSTREAM_ICS_URL, {
				headers: {
					'User-Agent': 'CalProxy/2.0',
					Accept: 'text/calendar',
				},
			});

			if (!response.ok) {
				const lastGood = await getLastGoodSnapshot(env.CALENDAR_STATE);
				if (lastGood && response.status >= 400) {
					console.log(`Upstream error ${response.status}, serving cached snapshot`);
					return createIcsResponse(lastGood, await computeEtag(lastGood));
				}
				return new Response(`Upstream calendar unavailable: ${response.status}`, {
					status: 502,
					headers: corsHeaders(),
				});
			}

			const rawIcs = await response.text();

			if (!rawIcs.includes('BEGIN:VCALENDAR')) {
				return new Response('Invalid ICS: missing VCALENDAR', {
					status: 502,
					headers: corsHeaders(),
				});
			}

			if (!rawIcs.includes('BEGIN:VEVENT')) {
				const lastGood = await getLastGoodSnapshot(env.CALENDAR_STATE);
				if (lastGood) {
					console.log('Empty feed detected, serving cached snapshot');
					return createIcsResponse(lastGood, await computeEtag(lastGood));
				}
			}

			const parsed = parseIcs(rawIcs);
			const normalized = await normalizeCalendar(parsed, env.CALENDAR_STATE, env.DEFAULT_TIMEZONE);
			const output = serializeCalendar(normalized, env.DEFAULT_TIMEZONE);

			const etag = await computeEtag(output);

			const ifNoneMatch = request.headers.get('If-None-Match');
			if (ifNoneMatch === etag) {
				return new Response(null, {
					status: 304,
					headers: {
						ETag: etag,
						...corsHeaders(),
					},
				});
			}

			ctx.waitUntil(saveSnapshot(env.CALENDAR_STATE, output));

			return createIcsResponse(output, etag);
		} catch (error) {
			console.error('Calendar processing error:', error);
			const lastGood = await getLastGoodSnapshot(env.CALENDAR_STATE);
			if (lastGood) {
				return createIcsResponse(lastGood, await computeEtag(lastGood));
			}
			return new Response(`Error processing calendar: ${error}`, {
				status: 500,
				headers: corsHeaders(),
			});
		}
	},
} satisfies ExportedHandler<Env>;

function corsHeaders(): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
		'Access-Control-Allow-Headers': 'If-None-Match',
	};
}

function createIcsResponse(content: string, etag: string): Response {
	return new Response(content, {
		headers: {
			'Content-Type': 'text/calendar; charset=utf-8',
			'Content-Disposition': 'attachment; filename="calendar.ics"',
			'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
			ETag: etag,
			...corsHeaders(),
		},
	});
}

async function normalizeCalendar(
	parsed: ReturnType<typeof parseIcs>,
	kv: KVNamespace,
	defaultTimezone?: string,
): Promise<NormalizedCalendar> {
	const normalizedEvents: NormalizedEvent[] = [];
	const currentKeys: string[] = [];
	const kvWrites: Promise<void>[] = [];

	for (const event of parsed.events) {
		const stableUid = await computeStableUid(event);
		const contentHash = await computeContentHash(event);
		const recurrenceIdProp = getProperty(event, 'RECURRENCE-ID');
		const isException = !!recurrenceIdProp;

		const eventKey = isException ? `${stableUid}#${recurrenceIdProp?.value}` : stableUid;
		currentKeys.push(eventKey);

		const prevState = await getEventState(kv, eventKey);
		let sequence = 0;

		if (prevState) {
			sequence = prevState.contentHash !== contentHash ? prevState.sequence + 1 : prevState.sequence;
		}

		const newState: EventState = {
			sequence,
			contentHash,
			lastSeen: Date.now(),
		};
		kvWrites.push(saveEventState(kv, eventKey, newState));

		const lines = normalizeEventLines(event, stableUid, sequence, defaultTimezone);
		normalizedEvents.push({
			stableUid,
			sequence,
			isException,
			recurrenceId: recurrenceIdProp?.value || null,
			lines,
		});
	}

	const prevSnapshot = await getPreviousSnapshot(kv);
	if (prevSnapshot) {
		const currentKeySet = new Set(currentKeys);
		for (const oldKey of prevSnapshot.eventKeys) {
			if (!currentKeySet.has(oldKey)) {
				const cancelled = await createCancelledEventFromState(kv, oldKey);
				if (cancelled) {
					normalizedEvents.push(cancelled);
					console.log(`Emitting cancellation for missing event: ${oldKey}`);
				}
			}
		}
	}

	kvWrites.push(saveSnapshotKeys(kv, currentKeys));
	await Promise.all(kvWrites);

	return { ...parsed, normalizedEvents };
}

async function createCancelledEventFromState(kv: KVNamespace, eventKey: string): Promise<NormalizedEvent | null> {
	const prevState = await getEventState(kv, eventKey);
	if (!prevState) return null;

	const [stableUid, recurrenceId] = eventKey.includes('#') ? eventKey.split('#') : [eventKey, null];

	const newSequence = prevState.sequence + 1;
	const newState: EventState = {
		sequence: newSequence,
		contentHash: 'CANCELLED',
		lastSeen: Date.now(),
	};
	await saveEventState(kv, eventKey, newState);

	const lines = createCancelledEventLines(stableUid, newSequence, recurrenceId);

	return {
		stableUid,
		sequence: newSequence,
		isException: !!recurrenceId,
		recurrenceId,
		lines,
	};
}
