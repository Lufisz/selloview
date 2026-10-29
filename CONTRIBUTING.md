# Contributing to MetricTV

Thanks for helping. MetricTV is deliberately small, so the bar is "would a new developer understand
this in one read?" more than "is this clever?".

## Before you start

- For anything bigger than a small fix, open an issue first and describe the problem you want to
  solve. A short discussion saves a rejected pull request.
- Read [AGENTS.md](AGENTS.md) for coding conventions and [SECURITY.md](SECURITY.md) for the trust
  boundaries. Both apply to human and AI-assisted contributions alike.

## Set up

Requires Node.js 22.13 or later.

```sh
npm ci --ignore-scripts
npm start          # sample dashboard on http://127.0.0.1:4317
npm run check      # syntax and formatting
npm test           # all tests
```

To run the full app locally, follow [docs/self-hosting.md](docs/self-hosting.md) with
`BETA_ORIGIN=http://127.0.0.1:4330` and a database path outside the project.

## What a good pull request looks like

- One change, explained in a sentence or two: what was wrong, what you changed, how you checked it.
- Plain code: descriptive names, ordinary loops and branches, readable multi-line templates.
  Reuse the existing helpers in `public/ui.js`, `public/board.js` and the CSS tokens at the top of
  `public/styles.css` instead of adding near-copies.
- No new dependency, framework or build step unless the issue agreed on it.
- Tests with **synthetic data only**. Never paste real store data, screenshots of a real store or
  credentials into code, tests or issues.
- `npm run format`, `npm run check` and `npm test` pass.
- For visual changes, a before and after screenshot at desktop and phone width, using the sample
  dashboard.

## Rules that are not up for debate

- Shopify access stays read-only and server-side. No token fields in the browser, no
  client-controlled queries, no new scopes without an issue explaining why.
- Every route authorizes on the server. Hiding a button is not authorization.
- Escape all external text before rendering it. Validate numbers before drawing charts.
- Unavailable is not zero, stale is not live. Never fill gaps with invented figures.
- The TV receives display data only: no owner details, store domain or admin links.

## Licence of contributions

MetricTV is licensed under AGPL-3.0. By opening a pull request you agree that your contribution is
licensed under the same terms.

## Reporting bugs

Include what you did, what you expected and what happened, your Node.js version and browser or TV
model. Remove store names, order numbers and amounts from logs and screenshots first.
