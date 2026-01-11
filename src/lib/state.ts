import type { CalendarSnapshot, EventState } from './types';

export async function getEventState(kv: KVNamespace, stableUid: string): Promise<EventState | null> {
	try {
		const data = await kv.get(`event:${stableUid}`);
		if (data) return JSON.parse(data);
	} catch {}
	return null;
}

export async function saveEventState(kv: KVNamespace, stableUid: string, state: EventState): Promise<void> {
	try {
		await kv.put(`event:${stableUid}`, JSON.stringify(state));
	} catch (e) {
		console.error('Failed to save event state:', e);
	}
}

export async function getPreviousSnapshot(kv: KVNamespace): Promise<CalendarSnapshot | null> {
	try {
		const data = await kv.get('snapshot:keys');
		if (data) return JSON.parse(data);
	} catch {}
	return null;
}

export async function saveSnapshotKeys(kv: KVNamespace, keys: string[]): Promise<void> {
	const snapshot: CalendarSnapshot = {
		eventKeys: keys,
		generatedAt: Date.now(),
	};
	try {
		await kv.put('snapshot:keys', JSON.stringify(snapshot));
	} catch (e) {
		console.error('Failed to save snapshot keys:', e);
	}
}

export async function getLastGoodSnapshot(kv: KVNamespace): Promise<string | null> {
	try {
		return await kv.get('snapshot:latest');
	} catch {
		return null;
	}
}

export async function saveSnapshot(kv: KVNamespace, content: string): Promise<void> {
	try {
		await kv.put('snapshot:latest', content);
	} catch (e) {
		console.error('Failed to save snapshot:', e);
	}
}
