import type { CalendarSnapshot, EventState } from './types';

export async function getEventState(kv: KVNamespace, stableUid: string, prefix?: string): Promise<EventState | null> {
	try {
		const key = prefix ? `${prefix}:event:${stableUid}` : `event:${stableUid}`;
		const data = await kv.get(key);
		if (data) return JSON.parse(data);
	} catch {}
	return null;
}

export async function saveEventState(
	kv: KVNamespace,
	stableUid: string,
	state: EventState,
	prefix?: string,
): Promise<void> {
	try {
		const key = prefix ? `${prefix}:event:${stableUid}` : `event:${stableUid}`;
		await kv.put(key, JSON.stringify(state));
	} catch (e) {
		console.error('Failed to save event state:', e);
	}
}

export async function getPreviousSnapshot(kv: KVNamespace, prefix?: string): Promise<CalendarSnapshot | null> {
	try {
		const key = prefix ? `${prefix}:snapshot:keys` : 'snapshot:keys';
		const data = await kv.get(key);
		if (data) return JSON.parse(data);
	} catch {}
	return null;
}

export async function saveSnapshotKeys(kv: KVNamespace, keys: string[], prefix?: string): Promise<void> {
	const snapshot: CalendarSnapshot = {
		eventKeys: keys,
		generatedAt: Date.now(),
	};
	try {
		const key = prefix ? `${prefix}:snapshot:keys` : 'snapshot:keys';
		await kv.put(key, JSON.stringify(snapshot));
	} catch (e) {
		console.error('Failed to save snapshot keys:', e);
	}
}

export async function getLastGoodSnapshot(kv: KVNamespace, prefix?: string): Promise<string | null> {
	try {
		const key = prefix ? `${prefix}:snapshot:latest` : 'snapshot:latest';
		return await kv.get(key);
	} catch {
		return null;
	}
}

export async function saveSnapshot(
	kv: KVNamespace,
	content: string,
	upstreamHash: string,
	prefix?: string,
): Promise<void> {
	try {
		const latestKey = prefix ? `${prefix}:snapshot:latest` : 'snapshot:latest';
		const hashKey = prefix ? `${prefix}:snapshot:upstream_hash` : 'snapshot:upstream_hash';
		await kv.put(latestKey, content);
		await kv.put(hashKey, upstreamHash);
	} catch (e) {
		console.error('Failed to save snapshot:', e);
	}
}

export async function getUpstreamHash(kv: KVNamespace, prefix?: string): Promise<string | null> {
	try {
		const key = prefix ? `${prefix}:snapshot:upstream_hash` : 'snapshot:upstream_hash';
		return await kv.get(key);
	} catch {
		return null;
	}
}

export interface TenantConfig {
	sourceUrl: string;
	createdAt: number;
	timezone?: string;
}

export async function getTenantConfig(kv: KVNamespace, hash: string): Promise<TenantConfig | null> {
	try {
		const data = await kv.get(`tenant:${hash}`);
		if (data) return JSON.parse(data);
	} catch {}
	return null;
}

export async function saveTenantConfig(kv: KVNamespace, hash: string, config: TenantConfig): Promise<void> {
	await kv.put(`tenant:${hash}`, JSON.stringify(config));
}

export async function deleteTenantConfig(kv: KVNamespace, hash: string): Promise<void> {
	await kv.delete(`tenant:${hash}`);
}

export async function deleteTenantData(kv: KVNamespace, hash: string): Promise<void> {
	await kv.delete(`tenant:${hash}`);

	const prefix = `${hash}:`;
	let cursor: string | undefined;

	do {
		const result = await kv.list({ prefix, cursor });
		const deletePromises = result.keys.map((key) => kv.delete(key.name));
		await Promise.all(deletePromises);
		cursor = result.list_complete ? undefined : result.cursor;
	} while (cursor);
}
