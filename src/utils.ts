import type { ConnectionInfo, WhimmyConfig, Logger } from './types';

const DEFAULT_HOST = 'api.whimmy.ai';

/**
 * Parse a whimmy:// connection URI into host + token + tls.
 *
 * Accepted formats:
 *   whimmy://{token}@{host}
 *   wss://{host}/api/v1/ws/gateway?token={token}
 *   {token}@{host}   (bare shorthand)
 */
export function parseConnectionUri(uri: string): ConnectionInfo | null {
  const trimmed = uri.trim();

  // Format: whimmy://{token}@{host}
  const whimmyMatch = trimmed.match(/^whimmy:\/\/([^@]+)@(.+)$/);
  if (whimmyMatch) {
    return {
      token: whimmyMatch[1],
      host: whimmyMatch[2],
      tls: true,
    };
  }

  // Format: wss://{host}/...?token={token}
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'wss:' || url.protocol === 'ws:') {
      const token = url.searchParams.get('token');
      if (token) {
        return {
          token,
          host: url.host,
          tls: url.protocol === 'wss:',
        };
      }
    }
  } catch {
    // Not a valid URL, try bare format
  }

  // Format: {token}@{host}
  const bareMatch = trimmed.match(/^([^@]+)@(.+)$/);
  if (bareMatch) {
    return {
      token: bareMatch[1],
      host: bareMatch[2],
      tls: true,
    };
  }

  return null;
}

/**
 * Exchange a 6-digit pairing code for a connection token.
 * Calls POST /api/v1/pair/redeem on the backend.
 */
export async function exchangePairingCode(
  code: string,
  host: string = DEFAULT_HOST,
  tls: boolean = true,
): Promise<ConnectionInfo> {
  const protocol = tls ? 'https' : 'http';
  const url = `${protocol}://${host}/api/v1/pair/redeem`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Pairing failed (${resp.status}): ${body}`);
  }

  const data = await resp.json() as { connectionToken: string };

  if (!data.connectionToken) {
    throw new Error('Pairing response missing connectionToken');
  }

  return {
    token: data.connectionToken,
    host,
    tls,
  };
}

/**
 * Resolve connection info from config.
 * Supports: connectionUri, host+token, or pairingCode (async exchange).
 * Returns null only if nothing is configured.
 */
export function resolveConnection(config: WhimmyConfig): ConnectionInfo | null {
  if (config.connectionUri) {
    return parseConnectionUri(config.connectionUri);
  }

  if (config.host && config.token) {
    return {
      host: config.host,
      token: config.token,
      tls: config.tls !== false,
    };
  }

  // pairingCode requires async exchange — resolved in resolveConnectionAsync
  return null;
}

/**
 * Async version of resolveConnection that handles pairing code exchange.
 */
export async function resolveConnectionAsync(
  config: WhimmyConfig,
  log?: Logger,
): Promise<ConnectionInfo | null> {
  // Try sync resolution first.
  const sync = resolveConnection(config);
  if (sync) return sync;

  // If a pairing code is set, exchange it.
  if (config.pairingCode) {
    const host = config.host || DEFAULT_HOST;
    const tls = config.tls !== false;

    log?.info?.(`[Whimmy] Exchanging pairing code with ${host}...`);
    const conn = await exchangePairingCode(config.pairingCode, host, tls);
    log?.info?.(`[Whimmy] Pairing successful — connected to ${host}`);
    return conn;
  }

  return null;
}

/**
 * Build the WebSocket URL from connection info.
 */
export function buildWsUrl(conn: ConnectionInfo): string {
  const protocol = conn.tls ? 'wss' : 'ws';
  return `${protocol}://${conn.host}/api/v1/ws/gateway?token=${encodeURIComponent(conn.token)}`;
}

/**
 * Check if a config has enough info to connect (sync or async).
 */
export function isConfigured(config: WhimmyConfig): boolean {
  if (config.connectionUri) return true;
  if (config.host && config.token) return true;
  if (config.pairingCode) return true;
  return false;
}

/**
 * Retry with exponential backoff.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number; log?: Logger } = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, log } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (attempt === maxRetries) throw err;
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      log?.debug?.(`[Whimmy] Retry attempt ${attempt}/${maxRetries} after ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error('Retry exhausted');
}
