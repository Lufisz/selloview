"""Actual HTTP boundary checks against the deliberately synthetic OAuth QA server."""
import json
import os
from urllib.parse import urlencode, urlsplit

from http_qa import request

BACKEND = os.environ['CONNECTION_QA_BACKEND'].rstrip('/')
ORIGIN = os.environ['CONNECTION_QA_ORIGIN'].rstrip('/')
OWNER_HEADERS = {
    'Host': urlsplit(ORIGIN).netloc,
    'Tailscale-User-Login': 'owner@example.com',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
}


def get_json(path, headers=OWNER_HEADERS, method='GET', body=None, follow_redirects=True):
    status, response_headers, response_body = request(
        BACKEND + path,
        headers=headers,
        method=method,
        body=body,
        follow_redirects=follow_redirects,
    )
    return status, response_headers, json.loads(response_body or b'{}')


def main():
    passed = []
    status, headers, state = get_json('/api/connection')
    assert status == 200
    assert state['mode'] == 'oauth' and state['state'] == 'not_connected'
    assert state['store'] == 'synthetic-store.myshopify.com'
    assert state['scopes'] == ['read_all_orders', 'read_orders', 'read_products', 'read_inventory']
    assert state['callbackUrl'] == ORIGIN + '/auth/shopify/callback'
    assert state['csrfToken']
    leaked = json.dumps(state).lower()
    assert not any(value in leaked for value in ['secret', 'encryption', 'token_store_path'])
    assert headers['Cache-Control'] == 'no-store'
    passed.append('Configured OAuth status has only safe display fields and a principal-bound CSRF token')

    status, _, body = get_json('/api/snapshot')
    assert status == 409 and body == {'error': 'store_not_connected'}
    passed.append('No snapshot is exposed before a real merchant authorization')

    for path in ['/api/connection', '/auth/shopify/start', '/auth/shopify/callback', '/api/connection/disconnect']:
        status, _, _ = get_json(path, headers={'Host': urlsplit(ORIGIN).netloc})
        assert status == 403
    passed.append('Every OAuth route remains inside the existing owner/Host gate')

    for origin in ['https://evil.example', 'http://metrictv-qa.invalid']:
        status, _, body = get_json('/auth/shopify/start', method='POST', body={'store': state['store']}, headers={**OWNER_HEADERS, 'Origin': origin, 'X-CSRF-Token': state['csrfToken']})
        assert status == 403 and body['error'] == 'forbidden'
    status, _, body = get_json('/auth/shopify/start', method='POST', body={'store': 'other.myshopify.com'}, headers={**OWNER_HEADERS, 'Origin': ORIGIN, 'X-CSRF-Token': state['csrfToken']})
    assert status == 400 and body['error'] == 'invalid_store'
    status, _, body = get_json('/auth/shopify/start', method='POST', body={'store': state['store']}, headers={**OWNER_HEADERS, 'Origin': ORIGIN, 'X-CSRF-Token': 'bad'})
    assert status == 403 and body['error'] == 'invalid_csrf'
    passed.append('Connect rejects cross-origin, wrong-store and invalid-CSRF requests before Shopify')

    status, headers, body = get_json('/auth/shopify/start', method='POST', body={'store': state['store']}, headers={**OWNER_HEADERS, 'Origin': ORIGIN, 'X-CSRF-Token': state['csrfToken']})
    assert status == 200
    authorize_url = body['authorizationUrl']
    parsed = urlsplit(authorize_url)
    assert parsed.scheme == 'https' and parsed.netloc == state['store'] and parsed.path == '/admin/oauth/authorize'
    cookie_header = headers.get('Set-Cookie', '').lower()
    assert 'httponly' in cookie_header and 'secure' in cookie_header
    assert 'secret' not in authorize_url.lower()
    passed.append('Connect issues only an exact-store Shopify authorization URL and secure state cookie')

    status, _, body = get_json('/auth/shopify/start', method='POST', body={'store': state['store'], 'extra': True}, headers={**OWNER_HEADERS, 'Origin': ORIGIN, 'X-CSRF-Token': state['csrfToken']})
    assert status == 400 and body['error'] == 'invalid_store'
    status, headers, body = get_json('/api/connection/disconnect', method='POST', body={}, headers={**OWNER_HEADERS, 'Origin': ORIGIN, 'X-CSRF-Token': state['csrfToken']})
    assert status == 200 and body == {'disconnected': True}
    assert headers['Cache-Control'] == 'no-store'
    passed.append('Malformed actions reject; local disconnect completes without a remote Shopify mutation')

    callback = '/auth/shopify/callback?' + urlencode({'shop': state['store'], 'code': 'synthetic-secret-code', 'state': 'synthetic-state', 'hmac': 'wrong'})
    status, headers, _ = get_json(callback, follow_redirects=False)
    assert status == 303
    assert headers['Location'] == '/?connection=failed#/connections'
    assert 'synthetic-secret-code' not in headers['Location']
    passed.append('Invalid callback never reflects its authorization code and returns only a safe result')

    status, _, body = get_json('/api/connection', method='POST', body={})
    assert status == 405 and body['error'] == 'method_not_allowed'
    print(json.dumps({'passed': passed}, indent=2))


if __name__ == '__main__':
    main()
