import {
	type EventState,
	type NormalizedCalendar,
	type NormalizedEvent,
	type TenantConfig,
	computeContentHash,
	computeEtag,
	computeHash,
	computeStableUid,
	createCancelledEventLines,
	deleteTenantData,
	getEventState,
	getLastGoodSnapshot,
	getProperty,
	getPreviousSnapshot,
	getTenantConfig,
	getUpstreamHash,
	normalizeEventLines,
	parseIcs,
	saveEventState,
	saveSnapshot,
	saveSnapshotKeys,
	saveTenantConfig,
	serializeCalendar,
} from './lib';

interface Env {
	CALENDAR_STATE: KVNamespace;
	ASSETS: Fetcher;
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

		if (url.pathname === '/health') {
			return new Response('OK', { status: 200 });
		}

		if (url.pathname === '/register' && request.method === 'POST') {
			return handleRegister(request, env, url);
		}

		const calendarMatch = url.pathname.match(/^\/([a-f0-9]+)\/calendar\.ics$/);
		if (calendarMatch) {
			const hash = calendarMatch[1];

			if (url.searchParams.get('delete') === '1') {
				return handleDelete(hash, env);
			}

			return handleCalendarRequest(request, hash, env, ctx);
		}

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

async function handleRegister(request: Request, env: Env, requestUrl: URL): Promise<Response> {
	let body: { url?: string; timezone?: string };
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ error: 'Invalid JSON body' }, 400);
	}

	const sourceUrl = body.url?.trim();
	if (!sourceUrl) {
		return jsonResponse({ error: 'Missing url field' }, 400);
	}

	try {
		new URL(sourceUrl);
	} catch {
		return jsonResponse({ error: 'Invalid URL format' }, 400);
	}

	if (!sourceUrl.toLowerCase().includes('.ics') && !sourceUrl.toLowerCase().includes('calendar')) {
		return jsonResponse({ error: 'URL does not appear to be a calendar feed' }, 400);
	}

	const timezone = body.timezone?.trim() || undefined;

	const hash = (await computeHash(sourceUrl)).slice(0, 16);

	const existingConfig = await getTenantConfig(env.CALENDAR_STATE, hash);
	if (!existingConfig) {
		const config: TenantConfig = {
			sourceUrl,
			createdAt: Date.now(),
			timezone,
		};
		await saveTenantConfig(env.CALENDAR_STATE, hash, config);
	} else if (timezone && existingConfig.timezone !== timezone) {
		const updatedConfig: TenantConfig = {
			...existingConfig,
			timezone,
		};
		await saveTenantConfig(env.CALENDAR_STATE, hash, updatedConfig);
	}

	const proxyUrl = `${requestUrl.protocol}//${requestUrl.host}/${hash}/calendar.ics`;

	return jsonResponse({ proxyUrl, hash });
}

async function handleDelete(hash: string, env: Env): Promise<Response> {
	const config = await getTenantConfig(env.CALENDAR_STATE, hash);
	if (!config) {
		return jsonResponse({ error: 'Calendar not found' }, 404);
	}

	await deleteTenantData(env.CALENDAR_STATE, hash);

	return jsonResponse({ success: true, message: 'Calendar deleted' });
}

async function handleCalendarRequest(
	request: Request,
	hash: string,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const config = await getTenantConfig(env.CALENDAR_STATE, hash);
	if (!config) {
		return new Response('Calendar not found', { status: 404 });
	}

	const effectiveTimezone = config.timezone || env.DEFAULT_TIMEZONE;

	try {
		const response = await fetch(config.sourceUrl, {
			headers: {
				'User-Agent': 'CalProxy/2.0',
				Accept: 'text/calendar',
			},
		});

		if (!response.ok) {
			const lastGood = await getLastGoodSnapshot(env.CALENDAR_STATE, hash);
			if (lastGood && response.status >= 400) {
				console.log(`Upstream error ${response.status}, serving cached snapshot for ${hash}`);
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
			const lastGood = await getLastGoodSnapshot(env.CALENDAR_STATE, hash);
			if (lastGood) {
				console.log(`Empty feed detected, serving cached snapshot for ${hash}`);
				return createIcsResponse(lastGood, await computeEtag(lastGood));
			}
		}

		const upstreamHash = await computeHash(rawIcs);
		const cachedHash = await getUpstreamHash(env.CALENDAR_STATE, hash);

		if (cachedHash === upstreamHash) {
			const cached = await getLastGoodSnapshot(env.CALENDAR_STATE, hash);
			if (cached) {
				const etag = await computeEtag(cached);
				const ifNoneMatch = request.headers.get('If-None-Match');
				if (ifNoneMatch === etag) {
					return new Response(null, {
						status: 304,
						headers: { ETag: etag, ...corsHeaders() },
					});
				}
				return createIcsResponse(cached, etag);
			}
		}

		const parsed = parseIcs(rawIcs);
		const normalized = await normalizeCalendar(parsed, env.CALENDAR_STATE, hash, effectiveTimezone);
		const output = serializeCalendar(normalized, effectiveTimezone);

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

		ctx.waitUntil(saveSnapshot(env.CALENDAR_STATE, output, upstreamHash, hash));

		return createIcsResponse(output, etag);
	} catch (error) {
		console.error(`Calendar processing error for ${hash}:`, error);
		const lastGood = await getLastGoodSnapshot(env.CALENDAR_STATE, hash);
		if (lastGood) {
			return createIcsResponse(lastGood, await computeEtag(lastGood));
		}
		return new Response(`Error processing calendar: ${error}`, {
			status: 500,
			headers: corsHeaders(),
		});
	}
}

function corsHeaders(): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
	};
}

function jsonResponse(data: Record<string, unknown>, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders(),
		},
	});
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
	tenantHash: string,
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

		const prevState = await getEventState(kv, eventKey, tenantHash);
		let sequence = 0;

		if (prevState) {
			sequence = prevState.contentHash !== contentHash ? prevState.sequence + 1 : prevState.sequence;
		}

		const newState: EventState = {
			sequence,
			contentHash,
			lastSeen: Date.now(),
		};
		kvWrites.push(saveEventState(kv, eventKey, newState, tenantHash));

		const lines = normalizeEventLines(event, stableUid, sequence, defaultTimezone);
		normalizedEvents.push({
			stableUid,
			sequence,
			isException,
			recurrenceId: recurrenceIdProp?.value || null,
			lines,
		});
	}

	const prevSnapshot = await getPreviousSnapshot(kv, tenantHash);
	if (prevSnapshot) {
		const currentKeySet = new Set(currentKeys);
		for (const oldKey of prevSnapshot.eventKeys) {
			if (!currentKeySet.has(oldKey)) {
				const cancelled = await createCancelledEventFromState(kv, oldKey, tenantHash);
				if (cancelled) {
					normalizedEvents.push(cancelled);
					console.log(`Emitting cancellation for missing event: ${oldKey} (tenant: ${tenantHash})`);
				}
			}
		}
	}

	kvWrites.push(saveSnapshotKeys(kv, currentKeys, tenantHash));
	await Promise.all(kvWrites);

	return { ...parsed, normalizedEvents };
}

async function createCancelledEventFromState(
	kv: KVNamespace,
	eventKey: string,
	tenantHash: string,
): Promise<NormalizedEvent | null> {
	const prevState = await getEventState(kv, eventKey, tenantHash);
	if (!prevState) return null;

	const [stableUid, recurrenceId] = eventKey.includes('#') ? eventKey.split('#') : [eventKey, null];

	const newSequence = prevState.sequence + 1;
	const newState: EventState = {
		sequence: newSequence,
		contentHash: 'CANCELLED',
		lastSeen: Date.now(),
	};
	await saveEventState(kv, eventKey, newState, tenantHash);

	const lines = createCancelledEventLines(stableUid, newSequence, recurrenceId);

	return {
		stableUid,
		sequence: newSequence,
		isException: !!recurrenceId,
		recurrenceId,
		lines,
	};
}
