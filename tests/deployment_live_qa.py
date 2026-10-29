"""Non-mutating HTTP checks against an already running private deployment."""
import json
import os
from urllib.parse import urlsplit
from http_qa import request

BASE = os.environ['LIVE_BASE_URL'].rstrip('/')
BACKEND = os.environ.get('LIVE_BACKEND_URL', 'http://127.0.0.1:4318')
OWNER = os.environ['LIVE_TEST_OWNER']
HOST = urlsplit(BASE).netloc


def main():
    passed = []
    status, headers, body = request(BASE + '/')
    assert status == 200
    assert b'/live.js' in body and b'src="/app.js"' not in body
    assert headers.get('Cache-Control') == 'no-store'
    assert headers.get('X-Content-Type-Options') == 'nosniff'
    assert headers.get('Referrer-Policy') == 'no-referrer'
    assert "connect-src 'self'" in headers.get('Content-Security-Policy', '')
    passed.append('Real HTTPS/Serve route returns live entry point and security headers')

    status, _, body = request(BASE + '/api/snapshot')
    assert status == 200, body[:100]
    snapshot = json.loads(body)
    assert snapshot['source'] == 'shopify' and snapshot['sync']['state'] == 'ok'
    assert snapshot['coverage']['ordersComplete'] and snapshot['coverage']['inventoryComplete']
    # Data-minimization checks concern keys, not substrings in product names.
    def check_keys(value):
        if isinstance(value, dict):
            assert not {'accessToken', 'refreshToken', 'customer', 'associatedUser', 'email', 'address'} & value.keys()
            for child in value.values():
                check_keys(child)
        elif isinstance(value, list):
            for child in value:
                check_keys(child)
    check_keys(snapshot)
    passed.append('Successful real Shopify sync, complete pagination and minimized display payload')

    for endpoint in ['/', '/api/snapshot', '/live.js']:
        assert request(BACKEND + endpoint, {'Host': HOST})[0] == 403
        assert request(BACKEND + endpoint, {'Host': HOST, 'Tailscale-User-Login': 'not-the-owner@example.com'})[0] == 403
        assert request(BACKEND + endpoint, {'Host': HOST, 'Tailscale-User-Login': OWNER + ',another@example.com'})[0] == 403
    assert request(BACKEND + '/', {'Host': 'wrong.example', 'Tailscale-User-Login': OWNER})[0] == 403
    passed.append('Anonymous, different-identity, mixed-identity and incorrect-Host requests denied on real backend')

    # Serve removes the forged user header and replaces it with this test client's
    # actual authenticated owner identity. This does not simulate another account.
    assert request(BASE + '/', {'Tailscale-User-Login': 'spoofed@example.com'})[0] == 200
    passed.append('Actual Tailscale proxy overwrites a forged client identity header')
    assert request(BASE + '/api/snapshot', method='POST')[0] == 405
    for endpoint in ['/.env', '/%2e%2e/README.md', '/server/shopify.mjs', '/package.json']:
        assert request(BASE + endpoint)[0] == 404
    assert request(BASE + '/api/snapshot', method='HEAD')[0] == 200
    assert request(os.environ.get('DEMO_BASE_URL', 'http://127.0.0.1:4317') + '/api/snapshot')[0] == 404
    passed.append('Writes and private files denied, HEAD works, sample server does not expose the live API')
    print(json.dumps({'passed': passed}, indent=2))


if __name__ == '__main__':
    main()
