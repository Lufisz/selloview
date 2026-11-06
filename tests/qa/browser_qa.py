"""Optional end-to-end QA. Requires Python Playwright and a local Chromium.
Run against the prototype server; no external accounts or network are used.
"""
import json
import os
import tempfile
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get('BASE_URL', 'http://127.0.0.1:4317')
CHROME = os.environ.get('CHROME')
OUTPUT = Path(os.environ.get('QA_OUTPUT', str(Path(tempfile.gettempdir()) / 'selloview-qa')))
OUTPUT.mkdir(parents=True, exist_ok=True)


def main():
    results = []
    errors = []
    external_requests = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        try:
            context = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
            if os.environ.get('HTTP_BRIDGE') == '1':
                # Some host firewalls block Chromium's localhost sockets. Fetch
                # the actual served bytes with Python, preserving status/CSP.
                # This is a transport workaround, not a fixture HTTP response.
                def transport(route):
                    with urlopen(route.request.url, timeout=10) as response:
                        route.fulfill(status=response.status, headers=dict(response.headers), body=response.read())
                context.route(BASE_URL + '/**', transport)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: external_requests.append(request.url) if not request.url.startswith(BASE_URL) else None)
            page.goto(BASE_URL)
            page.get_by_role('heading', name='Your business, in plain sight.').wait_for()
            page.screenshot(path=str(OUTPUT / 'home-desktop.png'), full_page=True)
            results.append('Landing renders')
            page.get_by_role('link', name='Create your board').first.click()
            page.locator('#store-domain').fill('not-a-shop.example.com')
            page.get_by_role('button', name='Continue', exact=False).click()
            assert page.locator('#store-domain').get_attribute('aria-invalid') == 'true'
            results.append('Invalid store address rejected')
            page.locator('#store-domain').fill('sunday-supply.myshopify.com')
            page.get_by_role('button', name='Continue', exact=False).click()
            page.get_by_role('heading', name='A little access. Nothing more.').wait_for()
            page.screenshot(path=str(OUTPUT / 'setup-desktop.png'), full_page=True)
            page.get_by_role('button', name='Approve sample connection').click()
            page.locator('#board-name').fill('Sunday Supply')
            page.locator('#board-goal').fill('6000')
            page.get_by_role('button', name='Open my sample board').click()
            page.wait_for_url('**/#/dashboard')
            assert page.locator('.metric-value').first.inner_text() == '€4,151.00'
            assert 'No store is connected' in page.locator('.prototype-notice').inner_text()
            page.screenshot(path=str(OUTPUT / 'dashboard-desktop.png'), full_page=True)
            results.append('Complete simulated setup and correct sample totals')
            page.locator('#period').select_option('today')
            assert page.locator('.metric-value').first.inner_text() == '€782.00'
            page.locator('#period').select_option('week')
            page.get_by_role('button', name='Review orders').click()
            assert page.locator('#info-dialog').is_visible()
            page.get_by_role('button', name='Got it').click()
            results.append('Period switching and attention dialog')
            assert page.locator('.metrics-context').count() == 1
            assert page.locator('.board .metric-unit, .board .chart-caption').count() == 0
            page.get_by_role('heading', name='Sales trend').wait_for()
            page.get_by_role('button', name='Preview a connection issue').click()
            assert page.locator('.error-banner').is_visible()
            assert page.locator('.metric-value').first.inner_text() == '€4,151.00'
            page.get_by_role('button', name='Restore sample', exact=True).click()
            assert page.locator('.error-banner').count() == 0
            results.append('Offline state preserves and labels cached sample')
            page.get_by_role('link', name='Settings', exact=True).click()
            page.locator('#settings-name').fill('Studio <test>')
            page.locator('#settings-goal').fill('8000')
            page.locator('#theme').select_option('dark')
            page.get_by_role('button', name='Save changes').click()
            page.reload()
            assert page.locator('#settings-name').input_value() == 'Studio <test>'
            page.get_by_role('link', name='Overview', exact=True).click()
            assert page.locator('.board-heading h1').inner_text() == 'Studio <test>.'
            assert page.locator('.board-heading test').count() == 0
            results.append('Settings persist and editable labels are escaped')
            page.get_by_role('link', name='TV mode').click()
            # The route changes after the click, so wait for the board instead of asking once.
            page.locator('.dark-board').wait_for()
            assert page.locator('.tv-shell .sample-badge').count() == 1
            assert page.locator('.tv-shell [data-action="attention"]').count() == 0
            assert page.locator('.tv-shell .tv-hint, .tv-shell .attention-footer').count() == 0
            page.set_viewport_size({'width': 1920, 'height': 1080})
            assert page.evaluate('document.documentElement.scrollHeight <= innerHeight'), 'TV preview exceeds a 1080p screen'
            contrast = page.evaluate('''() => {
                const channels = color => color.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => {
                    v /= 255;
                    return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
                });
                const luminance = color => channels(color).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
                const text = luminance(getComputedStyle(document.querySelector('.metric-value')).color);
                const background = luminance(getComputedStyle(document.querySelector('.board-tv')).backgroundColor);
                return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
            }''')
            assert contrast >= 4.5, f'Dark TV metric contrast: {contrast}'
            page.screenshot(path=str(OUTPUT / 'tv-dark-desktop.png'), full_page=True)
            page.keyboard.press('Escape')
            page.wait_for_url('**/#/dashboard')
            results.append('Dark TV view and keyboard exit')
            # Reset only this isolated test context, never real user storage.
            page.evaluate('localStorage.clear()')
            page.goto(BASE_URL)
            page.reload()
            for width in [360, 390, 768, 1440, 1920]:
                page.set_viewport_size({'width': width, 'height': 900})
                for route in ['/', '/dashboard', '/setup', '/connections', '/settings', '/tv']:
                    page.goto(BASE_URL + '#' + route)
                    page.locator('main').wait_for()
                    overflow = page.evaluate('document.documentElement.scrollWidth > window.innerWidth')
                    assert not overflow, f'Page overflow: {width}px {route}'
                    if width == 390 and route in ['/', '/dashboard', '/setup']:
                        name = {'/': 'home', '/dashboard': 'dashboard', '/setup': 'setup'}[route]
                        page.screenshot(path=str(OUTPUT / f'{name}-mobile.png'), full_page=True)
            results.append('All routes fit 360, 390, 768, 1440 and 1920px widths')
            assert not errors, errors
            assert not external_requests, external_requests
            results.append('No browser errors or external requests')
            report = {'passed': results, 'browser_errors': errors, 'external_requests': external_requests, 'screenshots': str(OUTPUT)}
            (OUTPUT / 'results.json').write_text(json.dumps(report, indent=2))
            print(json.dumps(report, indent=2))
        finally:
            browser.close()


if __name__ == '__main__':
    main()
