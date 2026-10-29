"""Real-browser checks of the synthetic-config HTTP harness, NOT a Shopify installation.

The browser receives actual MetricTV HTTP responses. We block the outbound authorization
navigation before it can contact Shopify; no fake successful merchant grant or metric is shown.
"""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright
from http_qa import request

ORIGIN = 'https://metrictv-qa.invalid'
STORE = 'synthetic-store.myshopify.com'
AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
OUTPUT = Path(os.environ['QA_OUTPUT'])
OUTPUT.mkdir(parents=True, exist_ok=True)


def bridge(backend):
    def transport(route):
        incoming = route.request
        path = urlsplit(incoming.url)
        target = backend + path.path + ('?' + path.query if path.query else '')
        headers = {key: value for key, value in incoming.all_headers().items()
                   if key not in ['host', 'connection', 'content-length', 'accept-encoding']}
        headers.update({'Host': urlsplit(ORIGIN).netloc, 'Tailscale-User-Login': 'owner@example.com'})
        body = json.loads(incoming.post_data) if incoming.post_data else None
        status, response_headers, response_body = request(target, headers=headers,
            method=incoming.method, body=body, follow_redirects=False)
        route.fulfill(status=status, headers=response_headers, body=response_body)
    return transport


def main():
    passed = []
    errors = []
    blocked_authorizations = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('CHROME'), headless=True)
        try:
            for mode, backend in [('ready', os.environ['CONNECTION_QA_BACKEND']),
                                  ('setup', os.environ['CONNECTION_QA_SETUP_BACKEND'])]:
                context = browser.new_context(user_agent=AGENT, reduced_motion='reduce')
                context.route(ORIGIN + '/**', bridge(backend))
                def block_shopify(route):
                    blocked_authorizations.append(route.request.url)
                    route.abort()
                context.route(f'https://{STORE}/**', block_shopify)
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(ORIGIN + '/#/connections')
                button_name = 'Connect Shopify' if mode == 'ready' else 'Connect Shopify unavailable'
                button = page.get_by_role('button', name=button_name, exact=True)
                button.wait_for()
                assert page.locator('.brand').inner_text() == 'Metric TV.'
                assert page.locator('.metric-value').count() == 0
                if mode == 'ready':
                    assert page.locator('#connect-store').input_value() == STORE
                    assert page.locator('#connect-store').get_attribute('readonly') is not None
                    assert button.is_enabled()
                else:
                    assert button.is_disabled()
                    assert page.locator('[data-connect-form]').count() == 0
                    assert ORIGIN + '/auth/shopify/callback' in page.locator('main').inner_text()
                for width in [360, 390, 768, 1440]:
                    page.set_viewport_size({'width': width, 'height': 1000})
                    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
                    page.screenshot(path=str(OUTPUT / f'{mode}-{width}.png'), full_page=True)
                storage = page.evaluate('JSON.stringify(localStorage)')
                assert 'csrf' not in storage.lower() and 'secret' not in storage.lower()
                passed.append(f'{mode}: real status, honest zero-metric state, controls and four widths')
                if mode == 'ready':
                    with page.expect_event('requestfailed', predicate=lambda req: req.url.startswith(f'https://{STORE}/admin/oauth/authorize')):
                        button.click()
                    assert blocked_authorizations
                    authorization = urlsplit(blocked_authorizations[-1])
                    assert authorization.netloc == STORE and authorization.path == '/admin/oauth/authorize'
                    cookies = context.cookies(ORIGIN + '/auth/shopify/callback')
                    state_cookies = [cookie for cookie in cookies if cookie['name'].startswith('shopify_app_state')]
                    assert len(state_cookies) == 2
                    assert all(cookie['secure'] and cookie['httpOnly'] for cookie in state_cookies)
                    passed.append('Real connect POST installs both secure state cookies and navigates to exact Shopify auth endpoint; outbound request blocked by test')
                    # The deliberately aborted navigation creates a Chrome error page. Use a
                    # fresh tab in the same context rather than racing its pending error load.
                    page.close()
                    page = context.new_page()
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto(ORIGIN + '/?connection=failed#/connections')
                    page.get_by_role('button', name='Connect Shopify', exact=True).wait_for()
                    assert 'connection=' not in page.url
                    assert page.locator('.connection-notice').count() > 0
                    assert page.locator('.metric-value').count() == 0
                    passed.append('Failed callback message is consumed once and never displays invented figures')
                context.close()
            assert not errors, errors
            print(json.dumps({'passed': passed, 'browser_errors': errors,
                'real_shopify_installation': 'not attempted; synthetic app configuration'}, indent=2))
        finally:
            browser.close()


if __name__ == '__main__':
    main()
