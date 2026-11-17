# Device authorization grant

For a client that cannot show a browser or take typing (a TV, a CLI, a kiosk): it shows a short code, the user
approves it on a phone or laptop. RFC 8628, served on every tenant host.

## Register a device client

```sh
bun run clients:create --tenant acme --name "Living room TV" --grants device_code
# a refresh token too, and no redirect URI needed
bun run clients:create --tenant acme --name "Living room TV" --grants device_code,refresh_token
```

From the console: `createClient(input: { name, type: PUBLIC, grantTypes: [DEVICE_CODE] })`; `redirectUris` may be
empty, and `updateClient` changes `grantTypes`. Without `DEVICE_CODE` in its grants a client gets
`unauthorized_client`.

## The device

```sh
# 1. ask for codes
curl -s https://acme.clavix.example/device_authorization \
  -d client_id=living-room-tv -d scope="openid email"
# { "device_code": "...", "user_code": "BCDF-GHJK",
#   "verification_uri": "https://acme.clavix.example/device",
#   "verification_uri_complete": "...", "expires_in": 600, "interval": 5 }

# 2. show verification_uri and user_code, then poll every `interval` seconds
curl -s https://acme.clavix.example/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code \
  -d device_code=... -d client_id=living-room-tv
```

| Answer                  | Meaning                                      |
| ----------------------- | -------------------------------------------- |
| `authorization_pending` | the user has not decided yet: keep polling   |
| `slow_down`             | polled too fast: add 5 s to the interval     |
| `access_denied`         | the user refused: stop                       |
| `expired_token`         | the code lived 10 minutes: ask for new codes |
| `invalid_grant`         | unknown, spent or another client's code      |

## The verification page

The page (`/device` on the tenant host, in clavix-ui) uses three operations of the tenant's hosted GraphQL API:

```graphql
query {
  oauthDeviceRequest(userCode: "BCDF-GHJK") {
    client {
      name
      host
    }
    resource
    scopes {
      name
      label
    }
    expiresAt
  }
}
mutation {
  approveOAuthDeviceRequest(userCode: "BCDF-GHJK", scopes: ["openid"])
}
mutation {
  denyOAuthDeviceRequest(userCode: "BCDF-GHJK")
}
```

`verification_uri_complete` is the `verification_uri` with `?user_code=…` added (for a QR code); the page reads it and
still shows the request for the user to approve.

The user code is typed by a person: case, spaces and the dash do not matter. The viewer must be signed in to this
tenant; approving needs a session proved in the last 5 minutes (`STEP_UP_REQUIRED` otherwise, the request stays
pending). Scope labels are the tenant's own texts in the viewer's language. A code of another tenant is
`NOT_FOUND`.

## Limits and abuse

- Lookups are counted per user, per client address and tenant, and per tenant (`CLAVIX_DEVICE_*`, see the README):
  past a limit, `DEVICE_CODE_THROTTLED` (429, `Retry-After`).
- The page must say who asks (name and host of the client) and what for, and warn the user never to approve a
  code another person gave them: a phishing attacker starts a flow on their own device and asks a victim to type
  the code.
- A suspended or deleted tenant refuses `/device_authorization` and `/token` with `TENANT_SUSPENDED`.
