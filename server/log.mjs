// Operational events: one JSON line each on stderr, for whatever collects the server's output
// (the systemd journal, docker logs). Pass only fields that are safe to print: ids, safe error
// codes and error names. Never emails, tokens, store names or error messages.
export function logEvent(event, fields = {}) {
  console.error(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
