// The one way the owner and TV pages talk to the server: same-origin JSON requests with a timeout,
// where a failure comes back as a value instead of an exception. The TV page loads this module
// on old browsers.

const REQUEST_TIMEOUT_MS = 12000;

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** @returns {Promise<{ok: boolean, status: number, data: object|null, error: string}>} */
export async function sendRequest({ fetchImpl, url, method = 'POST', body, csrfToken }) {
  const headers = {};
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  // TV browsers often have AbortController but not the newer AbortSignal.timeout API.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: controller.signal,
    });
    const data = await readJson(response);
    const error = response.ok ? '' : (data?.error ?? 'request_failed');
    return { ok: response.ok, status: response.status, data, error };
  } catch {
    return { ok: false, status: 0, data: null, error: 'offline' };
  } finally {
    clearTimeout(timeout);
  }
}
