# Self-service registration and landing routes

Implemented locally, not publicly enabled. Production services remain stopped.

## Routes

- `/`: product landing page, beta restrictions, pricing status and fictional preview.
- `/demo`: existing isolated sample dashboard. Its figures and simulated setup are not real store connections.
- `/app`: owner sign-in and workspace.
- `/register`: registration UI. It checks `/api/registration` before showing the email form.
- `/tv`: pairing and display-only board, unchanged.

## Enablement

Do not enable before the public-release gates in `hosted-release-plan.md` are met. No production environment values were changed by this implementation.

Configuration (operator controlled):

```
METRICTV_SELF_REGISTRATION=enabled
METRICTV_REGISTRATION_MAX_ACCOUNTS=10
```

Leaving the first variable unset preserves invite-only behavior. Invalid settings fail at startup. The cap counts all existing user accounts, including invited ones, not only new registrations. Existing owners can still sign in at capacity.

The existing Better Auth email-code endpoints are reused. A code request does not create an account. After successful code verification, the user-create hook checks verified email and remaining capacity. HTTP verifications are serialized in this single server process. This is not a distributed multi-process quota mechanism; do not scale multiple workers against the same database without replacing this mechanism with a transactional database-enforced admission rule. Concurrent CLI invitations are an operator action outside the self-service quota lock.

New-address code requests have per-client and deployment-wide hourly bounds in addition to existing auth limits. Public capacity status reveals only `enabled` and `available`, never email addresses or counts. Closed/full requests preserve account-enumeration resistance rather than revealing which email addresses already exist. Real delivery errors still surface as delivery failures.

## Not delivered by this slice

- Arbitrary merchant Shopify installation or multi-store credentials/configuration.
- Sending email to arbitrary recipients with the current `onboarding@resend.dev` sender.
- Checkout, subscriptions or enforced paid/free entitlements. The proposed one-screen tier is an offer hypothesis, not the current pilot screen cap.
- Metric selection, board presets or custom layouts. Current saved choices are reporting period and theme.
- Public source publication, final license, privacy/terms, self-service deletion or uninstall/privacy webhook handling.

Never present registration tests as proof that a different real merchant can install and use the app. The release acceptance criterion is a signed-out real merchant reaching their own real figures on a paired TV, with no operator-created account or credential workaround.
