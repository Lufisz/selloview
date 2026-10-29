"""Verify MetricTV branding and pre-rename preferences on the real demo/live pages."""
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

DEMO = os.environ.get('BASE_URL', 'http://127.0.0.1:4317').rstrip('/')
LIVE = os.environ['LIVE_BASE_URL'].rstrip('/')
OUTPUT = Path(os.environ['QA_OUTPUT'])
OUTPUT.mkdir(parents=True, exist_ok=True)


def transport(route):
    try:
        with urlopen(route.request.url, timeout=15) as response:
            route.fulfill(status=response.status, headers=dict(response.headers), body=response.read())
    except HTTPError as error:
        route.fulfill(status=error.code, headers=dict(error.headers), body=error.read())


def main():
    results = []
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('CHROME'), headless=True)
        try:
            for base, mode in [(DEMO, 'demo'), (LIVE, 'live')]:
                context = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
                if os.environ.get('HTTP_BRIDGE') == '1':
                    context.route(base + '/**', transport)
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(base + '/#/dashboard')
                page.locator('.metric-value').first.wait_for()
                assert page.title().startswith('MetricTV · ')
                assert page.locator('.brand').inner_text() == 'Metric TV.'
                assert page.locator('.brand').get_attribute('aria-label').startswith('MetricTV ')

                # This is an isolated test context, not the owner's browser storage.
                if mode == 'demo':
                    page.evaluate("localStorage.setItem('stillboard-prototype-v1', JSON.stringify({name:'Preserved preferences',goal:8000,theme:'dark'}))")
                else:
                    page.evaluate("localStorage.setItem('stillboard-live-v1', JSON.stringify({period:'today',theme:'dark'}))")
                page.reload()
                page.locator('.metric-value').first.wait_for()
                if mode == 'demo':
                    assert page.locator('.board-heading h1').inner_text() == 'Preserved preferences.'
                    page.get_by_role('button', name='Project notes', exact=True).click()
                    assert 'METRICTV PROTOTYPE' in page.locator('#info-dialog').inner_text()
                    assert 'MetricTV is a working prototype' in page.locator('#info-dialog').inner_text()
                    page.get_by_role('button', name='Got it', exact=True).click()
                else:
                    assert page.locator('#period').input_value() == 'today'
                for width in [360, 390, 768, 1440]:
                    page.set_viewport_size({'width': width, 'height': 1000})
                    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
                    underline = page.locator('.site-header nav a[aria-current]').evaluate('''element => {
                        const style = getComputedStyle(element);
                        return {line:style.textDecorationLine, offset:parseFloat(style.textUnderlineOffset)};
                    }''')
                    assert 'underline' in underline['line']
                    assert 0 < underline['offset'] <= 10, underline
                    page.screenshot(path=str(OUTPUT / f'{mode}-{width}.png'), full_page=True)
                page.get_by_role('link', name='TV mode', exact=True).click()
                page.locator('.dark-board').wait_for()
                assert page.title().startswith('MetricTV · ')
                assert page.locator('.brand').inner_text() == 'Metric TV.'
                results.append(f'{mode}: new wordmark/title/dialog branding, existing preferences and responsive/TV views verified')
                context.close()
            assert not errors, errors
            print(json.dumps({'passed': results, 'browser_errors': errors}, indent=2))
        finally:
            browser.close()


if __name__ == '__main__':
    main()
