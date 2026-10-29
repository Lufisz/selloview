"""Small real-HTTP transport shared by deployment and connection QA."""
import json
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def response_headers(headers):
    values = dict(headers)
    cookies = headers.get_all('Set-Cookie')
    if cookies:
        # Playwright accepts newline-separated Set-Cookie values when fulfilling a route.
        values['Set-Cookie'] = '\n'.join(cookies)
    return values


def request(url, headers=None, method='GET', body=None, follow_redirects=True):
    headers = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers.setdefault('Content-Type', 'application/json')
    operation = urlopen if follow_redirects else build_opener(NoRedirect()).open
    try:
        with operation(Request(url, headers=headers, method=method, data=data), timeout=15) as response:
            return response.status, response_headers(response.headers), response.read()
    except HTTPError as error:
        return error.code, response_headers(error.headers), error.read()
