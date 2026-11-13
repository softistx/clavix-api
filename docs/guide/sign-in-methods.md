# Sign-in methods and social providers

Each tenant chooses how its users sign in: which methods its hosted sign-in page offers, and which
social providers, each with the tenant's own app (client id and secret). A tenant admin sets the
policy on the console API; the hosted pages read what to offer on the tenant's host.

## Defaults

| Method       | New tenant | Notes                                                             |
| ------------ | ---------- | ----------------------------------------------------------------- |
| `PASSKEY`    | on         |                                                                   |
| `EMAIL_CODE` | on         |                                                                   |
| `MAGIC_LINK` | off        | see [magic-link.md](magic-link.md)                                |
| `PASSWORD`   | off        | `available: false`: listed, cannot be turned on until it is built |

No social provider is configured. There is no global switch: the former `CLAVIX_MAGIC_LINK`
variable is gone and ignored, and a tenant that wants the link turns it on here.

## Console API (`POST /console/graphql`)

`signInPolicy` needs the `view` permission on the tenant (owner, admin or viewer), the mutations
`edit` (owner or admin). A platform role covers every tenant. Anyone else gets `FORBIDDEN`.

```graphql
query ($tenantId: ID!) {
  signInPolicy(tenantId: $tenantId) {
    version
    methods {
      type
      enabled
      available
    }
    social {
      provider
      clientId
      hasSecret
      enabled
      callbackUrl
    }
  }
}
```

### Turn methods on or off

A type left out keeps its value; the call returns the whole policy.

```graphql
mutation ($tenantId: ID!) {
  updateSignInMethods(
    tenantId: $tenantId
    methods: [
      { type: MAGIC_LINK, enabled: true }
      { type: PASSKEY, enabled: false }
    ]
  ) {
    version
    methods {
      type
      enabled
      available
    }
  }
}
```

### Bring a social app

1. Read the provider's `callbackUrl` after a first `setSocialProvider` (or build it:
   `https://<tenant host>/sign-in/social/<google|github|microsoft>/callback`) and register it as the
   redirect URI of the app in the provider's console.
2. Send the app's client id and secret:

```graphql
mutation ($tenantId: ID!, $secret: String!) {
  setSocialProvider(
    tenantId: $tenantId
    input: {
      provider: GITHUB
      clientId: "Iv1.0123456789abcdef"
      clientSecret: $secret
    }
  ) {
    social {
      provider
      clientId
      hasSecret
      enabled
      callbackUrl
    }
  }
}
```

- The first call for a provider needs `clientId` and `clientSecret`; `enabled` defaults to `true`.
- Later calls change only what they send: `{ provider: GITHUB, enabled: false }` turns it off and
  keeps the app; `{ provider: GITHUB, clientSecret: $new }` rotates the secret.
- `removeSocialProvider(tenantId, provider)` deletes the app and its secret.
- A new user is created from a provider account only when the tenant's sign-up is open; otherwise
  the account's verified e-mail must already belong to a user of the tenant.

### Errors

| Code                         | HTTP | When                                                                                    |
| ---------------------------- | ---- | --------------------------------------------------------------------------------------- |
| `FORBIDDEN`                  |      | the caller lacks the permission on that tenant                                          |
| `NOT_FOUND`                  | 404  | a platform operator names an unknown or inactive tenant                                 |
| `NO_SIGN_IN_METHOD`          | 409  | the change would leave no enabled method and no enabled provider                        |
| `SIGN_IN_METHOD_UNAVAILABLE` | 409  | enabling a method with `available: false` (`PASSWORD`)                                  |
| `SOCIAL_SECRET_REQUIRED`     | 400  | a provider set for the first time without `clientSecret`                                |
| `BAD_USER_INPUT`             | 400  | a type given twice; a new provider without `clientId`; an empty or >512-character value |

Every mutation is idempotent: the same call again changes nothing, and `version` stays the same.
`version` is the tenant's version; when it rises, the tenant's sign-in follows within a minute.

## Hosted pages (`POST /graphql` on the tenant's host)

```graphql
{
  hostedSignInMethods {
    methods
    social {
      id
      label
    }
  }
}
# { "methods": ["PASSKEY", "EMAIL_CODE"], "social": [{ "id": "github", "label": "GitHub" }] }
```

Public, by host; an unknown host is `NOT_FOUND`. It lists only what is enabled, and never a client
id or a secret. Show a button per entry and nothing else: an operation of a method that is off
answers 404 `SIGN_IN_METHOD_DISABLED` (`MAGIC_LINK_DISABLED` for the link) before anything is
counted or mailed.

### Social sign-in

```graphql
mutation {
  socialSignInStart(provider: "github", returnTo: "/account") {
    url
    flow
    expiresAt
  }
}
```

1. The page's server keeps `flow` in its own HttpOnly, SameSite=Lax cookie (never in a URL or a
   log) and redirects the visitor to `url`.
2. The provider sends the visitor back to `/sign-in/social/<provider>/callback?code=…&state=…`.
3. The page's server sends that full URL and the kept `flow`:

```graphql
mutation ($callbackUrl: String!, $flow: String!) {
  socialSignInComplete(callbackUrl: $callbackUrl, flow: $flow) {
    created
    returnTo
    expiresAt
    user {
      id
      email
      name
      emailVerified
    }
  }
}
```

The `__Host-clavix-session` cookie is set on the response; forward it to the browser, then go to
`returnTo`.

| Code                                                               | HTTP        | When                                                                   |
| ------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------- |
| `SIGN_IN_METHOD_DISABLED`                                          | 404         | the tenant does not offer that provider (or any)                       |
| `MAIL_THROTTLED`                                                   | 429         | the sign-in limits of the tenant or the client address (`Retry-After`) |
| `FLOW_EXPIRED`, `FLOW_MISMATCH`                                    |             | the flow is too old, spent, or not the one the callback belongs to     |
| `PROVIDER_ERROR`                                                   | 502         | the provider refused the code or could not be reached                  |
| `SIGN_UP_DISABLED`                                                 | 403         | no user holds the account's e-mail and the tenant's sign-up is closed  |
| `EMAIL_UNVERIFIED`, `EMAIL_NOT_VERIFIED_FOR_LINK`, `USER_INACTIVE` | 403/409/403 | janus's account rules                                                  |

A flow started on one tenant's host cannot be completed on another's.

## How secrets are kept

- A client secret is sealed before it reaches the database: AES-256-GCM under a 32-byte key derived
  from `CLAVIX_KEYS_MASTER_KEY` with HKDF-SHA256 (info `social-secrets`), a fresh 12-byte IV per
  secret.
- It is stored as a versioned envelope:

  ```json
  { "v": 1, "kid": "<id of the derived key>", "iv": "<base64url>", "ct": "<base64url, ciphertext then tag>" }
  ```

- The tenant id and the provider are authenticated with it, so an envelope copied to another tenant
  or provider does not open.
- No query or mutation returns it (`hasSecret` only), and it is in no log line or error message.
- **Losing or changing the master key** makes stored secrets unreadable. The provider is then left
  out of the tenant's sign-in (its other methods keep working), the server logs
  `social: <provider> of tenant <id> is off (...)`, and an admin enters the secret again with
  `setSocialProvider`.
