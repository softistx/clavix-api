# Magic-link sign-in

A user signs in from a link sent to their e-mail. Off by default; `CLAVIX_MAGIC_LINK=true` turns it
on for every tenant. Built on janus's `magicLink` (prepare, send, confirm).

## What the hosted page calls

On the tenant's host, `POST /graphql` with a JSON body (same origin as the page):

| Operation                 | Input           | Answer                                                                                       | Refusals                                                                                        |
| ------------------------- | --------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `requestMagicLink(email)` | `EmailAddress!` | `{ expiresAt }` (15 minutes), always, known address or not                                   | `MAGIC_LINK_DISABLED` 404, `MAIL_THROTTLED` 429 (`Retry-After`), `NOT_FOUND` 404 (unknown host) |
| `confirmMagicLink(token)` | `String!`       | `{ user { id email name emailVerified }, expiresAt }` and the `__Host-clavix-session` cookie | `MAGIC_LINK_DISABLED` 404, `MAGIC_LINK_INVALID` 401, `NOT_FOUND` 404                            |

Flow of the page `/sign-in/link`:
1. The e-mail's button opens `https://<slug>.<CLAVIX_DOMAIN>/sign-in/link?token=<token>`.
2. That page only shows a "Sign in" button. It does **not** sign in on load: mail scanners open links.
3. The button POSTs `confirmMagicLink(token)` (from the BFF, forwarding the `Set-Cookie`), then goes on.
4. `MAGIC_LINK_INVALID`: show "this link is no longer valid" and a form that calls `requestMagicLink`.

Hide the "e-mail me a link" button when `requestMagicLink` answers 404 `MAGIC_LINK_DISABLED`.

## Behaviour

- **No enumeration**: the request is counted, then the answer is the same for an account, an unknown
  address and, on a closed tenant, an address not invited. Account creation (open tenants), the lookup
  and the mail happen after the answer.
- **One live link per user**: a new request spends the previous link.
- **The link proves the e-mail** (`emailVerified` becomes true). janus 0.57 refuses to enrol a passkey
  or second factor while it is unproved (`EMAIL_UNVERIFIED` 403, see troubleshooting), which closes
  the case where a first link sign-in wiped a factor enrolled before the e-mail was proved.
- **Limits**: janus's 5 requests per address and 10 minutes, plus the per-IP and per-tenant
  "Sign-in code limits", shared with the e-mail code.
- **Off**: both operations answer 404 `MAGIC_LINK_DISABLED` before any store access or budget; a link
  mailed earlier is not spent.

See also the README "Magic-link sign-in" and [troubleshooting](../troubleshooting.md).
