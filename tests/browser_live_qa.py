"""Exercise the running private live board against its actual cached Shopify snapshot.

This does not replace store data with fixtures. Explicit network/403 fault injections
only test error handling after a real successful load. No Shopify mutations occur.
"""
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

BASE = os.environ['LIVE_BASE_URL'].rstrip('/')
CHROME = os.environ.get('CHROME')
OUTPUT = Path(os.environ['QA_OUTPUT'])
OUTPUT.mkdir(parents=True, exist_ok=True)


def main():
    with urlopen(BASE + '/api/snapshot', timeout=15) as response:
        actual = json.load(response)
    assert actual['source'] == 'shopify'
    assert actual['sync']['state'] == 'ok', actual['sync']['errorCode']
    results, errors, outside = [], [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        try:
            context = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
            if os.environ.get('HTTP_BRIDGE') == '1':
                # Preserve actual TLS/Serve responses, including CSP and identity
                # authorization. Python, not a fake fixture, transports each request.
                def transport(route):
                    try:
                        with urlopen(route.request.url, timeout=15) as response:
                            route.fulfill(status=response.status, headers=dict(response.headers), body=response.read())
                    except HTTPError as error:
                        route.fulfill(status=error.code, headers=dict(error.headers), body=error.read())
                context.route(BASE + '/**', transport)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: outside.append(request.url) if not request.url.startswith(BASE) else None)
            page.goto(BASE)
            page.locator('.metric-value').first.wait_for()
            page.get_by_role('heading', name=actual['shop']['name'] + '.', exact=True).wait_for()
            assert page.locator('.prototype-notice').count() == 0
            assert page.locator('.metric-value').count() == 4
            assert not page.locator('.error-banner').count()
            assert page.locator('svg.revenue-chart').count() == 1
            assert 'NaN' not in page.locator('svg.revenue-chart').inner_html()
            assert 'Infinity' not in page.locator('svg.revenue-chart').inner_html()
            results.append('Actual authenticated Shopify snapshot renders without sample data')

            for key in ['week', 'today']:
                page.locator('#period').select_option(key)
                expected = actual['periods'][key]['current']
                formatted = page.evaluate('''args => new Intl.NumberFormat('en-IE', {
                    style:'currency', currency:args.currency, minimumFractionDigits:2, maximumFractionDigits:2
                }).format(args.cents / 100)''', {'currency': actual['shop']['currency'], 'cents': expected['valueCents']})
                assert page.locator('.metric-value').nth(0).inner_text() == formatted
                assert int(page.locator('.metric-value').nth(1).inner_text()) == expected['orders']
                assert int(page.locator('.metric-value').nth(3).inner_text()) == actual['backlog']['count']
            results.append('Week/today order values and counts match actual API snapshot; backlog remains independent')
            page.locator('#period').select_option('week')
            page.get_by_role('button', name='How order value is defined').click()
            assert page.locator('#info-dialog').is_visible()
            assert actual['metricDefinition'] in page.locator('#info-dialog').inner_text()
            page.get_by_role('button', name='Got it').click()
            page.screenshot(path=str(OUTPUT / 'live-desktop.png'), full_page=True)
            results.append('Definition dialog explains live calculation and coverage')

            for width in [360, 390, 768, 1440]:
                page.set_viewport_size({'width': width, 'height': 1000})
                assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), f'overflow {width}'
                heights = page.locator('.board-controls > select, .board-controls > a').evaluate_all('els => els.map(e => e.getBoundingClientRect().height)')
                assert heights == [44, 44], heights
                if width == 390:
                    page.screenshot(path=str(OUTPUT / 'live-mobile.png'), full_page=True)
            results.append('360/390/768/1440px responsive layout and matched 44px controls')
            page.set_viewport_size({'width': 1440, 'height': 1000})
            page.get_by_role('link', name='Connection', exact=True).click()
            page.get_by_role('heading', name='Your store, connected.').wait_for()
            assert actual['shop']['domain'] in page.locator('.connection-card').inner_text()
            assert 'CLI session can expire' in page.locator('.live-notes').inner_text()
            page.get_by_role('link', name='Back to overview').click()
            page.get_by_role('link', name='TV mode', exact=True).click()
            page.set_viewport_size({'width': 1920, 'height': 1080})
            assert not page.evaluate('document.documentElement.scrollHeight > innerHeight'), 'light TV exceeds1080p'
            assert page.locator('.orders-panel').count() == 0
            page.screenshot(path=str(OUTPUT / 'live-tv-light.png'), full_page=True)
            page.get_by_role('button', name='Dark view', exact=True).click()
            assert page.locator('.dark-board').count() == 1
            assert not page.evaluate('document.documentElement.scrollHeight > innerHeight'), 'dark TV exceeds1080p'
            page.screenshot(path=str(OUTPUT / 'live-tv-dark.png'), full_page=True)
            page.reload()
            page.locator('.dark-board').wait_for()
            saved = page.evaluate("JSON.parse(localStorage.getItem('stillboard-live-v1'))")
            assert sorted(saved) == ['period', 'theme'], 'business data leaked to localStorage'
            page.keyboard.press('Escape')
            page.wait_for_url('**/#/dashboard')
            results.append('Connection details, light/dark1080p TV, theme persistence and Escape exit')

            # Intentional faults, not replacement metrics. Last successful values
            # remain visible on transport failure, but are cleared after revocation.
            previous_value = page.locator('.metric-value').first.inner_text()
            def fail_network(route):
                route.abort('failed')
            context.route(BASE + '/api/snapshot', fail_network)
            page.evaluate("dispatchEvent(new Event('online'))")
            page.locator('.error-banner').wait_for()
            assert page.locator('.metric-value').first.inner_text() == previous_value
            assert 'last successful figures' in page.locator('.error-banner').inner_text()
            context.unroute(BASE + '/api/snapshot', fail_network)
            page.evaluate("dispatchEvent(new Event('online'))")
            page.locator('.error-banner').wait_for(state='detached')
            def revoke_access(route):
                route.fulfill(status=403, body='Forbidden')
            context.route(BASE + '/api/snapshot', revoke_access)
            page.evaluate("dispatchEvent(new Event('online'))")
            page.get_by_text('This screen is not authorized.', exact=False).wait_for()
            assert page.locator('.metric-value').count() == 0
            context.unroute(BASE + '/api/snapshot', revoke_access)
            page.get_by_role('button', name='Check again', exact=True).click()
            page.locator('.metric-value').first.wait_for()
            assert page.locator('.error-banner').count() == 0
            results.append('Fault injection: network failure labels old figures, revocation clears them, recovery loads real data')
            assert not errors, errors
            assert not outside, outside
            results.append('No uncaught browser errors or third-party network requests')
            report = {'passed': results, 'browser_errors': errors, 'external_requests': outside, 'screenshots': str(OUTPUT)}
            (OUTPUT / 'results.json').write_text(json.dumps(report, indent=2))
            print(json.dumps(report, indent=2))
        finally:
            browser.close()


if __name__ == '__main__':
    main()
