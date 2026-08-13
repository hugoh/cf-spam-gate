export interface Route {
  destinations: string[];
  threshold?: number;
}

interface StoredRoute {
  destinations?: string[];
  threshold?: number;
}

/**
 * Looks up the forwarding destination(s) for a protected recipient in the
 * ROUTES KV namespace. Returns null when the recipient isn't configured
 * (i.e. this worker shouldn't handle it) rather than throwing, so callers
 * can decide how to treat unconfigured addresses.
 */
export async function lookupRoute(
  kv: KVNamespace,
  recipient: string,
): Promise<Route | null> {
  const raw = await kv.get(recipient.toLowerCase());
  if (raw === null) {
    return null;
  }

  let stored: StoredRoute;
  try {
    stored = JSON.parse(raw);
  } catch {
    throw new Error(`malformed ROUTES entry for ${recipient}: not valid JSON`);
  }

  if (!stored.destinations || stored.destinations.length === 0) {
    throw new Error(
      `malformed ROUTES entry for ${recipient}: destinations must be a non-empty array`,
    );
  }

  return { destinations: stored.destinations, threshold: stored.threshold };
}
