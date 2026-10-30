# Testing

Tests use Node's built-in runner, so there is nothing to install beyond the project itself.

```sh
npm test                                                      # everything, about 30 seconds
node --test tests/server/metrics.test.mjs                     # one file
node --test --test-name-pattern="reload" tests/browser/tv-flow.test.mjs   # tests whose title matches
node --test --experimental-test-coverage "tests/**/*.test.mjs"            # with a coverage table
```

## Layout

| Folder | What it tests | How |
| --- | --- | --- |
| `tests/server/` | the server modules, and the app over real HTTP | the real app, Better Auth and SQLite on temporary files; only Shopify and email are synthetic |
| `tests/browser/` | the code in `public/` | page controllers run under Node against a fake page; there is no browser |
| `tests/helpers/` | shared setup for both | see below |
| `tests/qa/` | the sample board in a real browser | an optional Python script |

A test file is named for what it exercises, not for when it was written. Test titles are sentences that say the behaviour: `a TV that is told a slower pace polls at that pace`.

## Synthetic data only

Emails end in `example.test`, stores are invented `*.myshopify.com` names, and every figure is made up. Never paste real store data, order numbers, screenshots or credentials into a test, a fixture or an issue. Failure injection (a provider that is down, a corrupt grant file) is fine when the test says so; a test never fills a gap with invented live figures.

## Which helper to use

| You are testing | Use |
| --- | --- |
| a pure function | import it and call it; build store figures with `syntheticSnapshot` (`helpers/synthetic-snapshot.mjs`), which runs invented orders through the real `buildSnapshot` |
| an HTTP route or the sign-in flow | `createAppEnvironment`, `startAppServer`, `createBrowser`, `signInOwner` (`helpers/app-server.mjs`). `createBrowser` is a small cookie-keeping client that speaks real HTTP through `curl`; these tests skip themselves when `curl` is missing |
| the Shopify connection, a grant, TV pairing | `createScenario`, `connectOwner`, `pairTv` (`helpers/shopify-scenario.mjs`) with `createSyntheticShopify` (`helpers/synthetic-shopify.mjs`), a stand-in for Shopify's servers |
| what the owner page does | `runOwnerPage` (`helpers/owner-page.mjs`): runs `public/owner/owner.js` against a fake page, gives it scripted server answers, plays a list of actions (submit, click, type, tick) and returns the HTML and requests after each |
| what the TV page does | `runTvPage` (`helpers/tv-page.mjs`): the same idea, on an older-browser surface without `Object.hasOwn` or `replaceAll`, with scripted time |
| which files a page loads | `pageClosure` (`helpers/page-closure.mjs`): the files a page pulls in through its scripts, stylesheets and imports |
| which files may be served | `makePublicDirectory` builds a throwaway `public/` next to things that must never be served (dotfiles, a symlink out, an oversized file); `ATTACK_PATHS` lists hostile request targets (`helpers/public-directory.mjs`) |

Temporary directories come from `makeTemporaryDirectory`, never from `os.tmpdir()` directly: on macOS that path is a symlink, and the grant store refuses symlinked directories.

## Habits that keep the tests honest

- A bug fix starts with a test that fails for the right reason, then the fix.
- After writing a test, break the code on purpose and watch the test fail. A test that still passes was not testing that line. Several tests here were tightened this way.
- Fix the code, not the test, unless the test is wrong.
- A security boundary (who may read what, which file may be served, what a TV may see) gets a test in `tests/server/`, over real HTTP where the exact bytes matter.

## A real browser: the sample board

`tests/qa/browser_qa.py` drives the sample board in Chrome: the setup flow, period switching, settings, the dark TV view, and that every route fits widths from 360 to 1920 px, with no console errors and no request leaving the server. It needs Python 3 with [Playwright](https://playwright.dev/python/) and a Chrome or Chromium. It does not cover the owner page or the TV page; those are covered by the Node tests above.

```sh
npm start                                  # in one terminal, http://127.0.0.1:4317
python3 tests/qa/browser_qa.py             # in another
```

| Setting | Meaning |
| --- | --- |
| `BASE_URL` | where the sample runs, default `http://127.0.0.1:4317` |
| `CHROME` | path to a Chrome or Chromium executable; unset uses Playwright's own (`playwright install chromium`) |
| `QA_OUTPUT` | where screenshots and `results.json` go, default `metrictv-qa` in the system temp directory. Keep it outside the repository |
| `HTTP_BRIDGE=1` | fetch pages with Python instead of the browser, for hosts whose firewall blocks Chrome's localhost sockets |
