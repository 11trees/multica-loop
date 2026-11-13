# Local single-user access

The confirmed deployment target is one user on their own machine. Web, CLI,
and development Desktop share that local identity and workspace.

Set `MULTICA_LOCAL_AUTH=true` in the checkout's ignored `.env`, then restart it
through `make down` followed by `make up C=api,web`. Open the local Web address
printed by that command. The option is read when the backend starts.
The root page enters the automatic sign-in path and opens `loopwork-local`.
There is no email, verification code, or OAuth step. The default is `false`.

The shared Web/Desktop login view reads `local_auth_enabled` from `/api/config`.
It calls `POST /auth/local`, stores an ordinary session using the platform's
existing cookie/token mode, loads the workspace list, and follows the existing
post-login navigation. Failures show a retry action. CLI browser authorization
still asks before handing credentials to a callback URL.

## Identity and scope

The server creates a reserved local user (`local@multica-loop.invalid`), a
`loopwork-local` workspace, owner membership, and the standard issue statuses
in one transaction. Repeated requests reuse these records. The bootstrap is
serialized to handle two browser tabs starting together. Existing users and
workspaces are not adopted or merged into this identity.

The entry accepts direct loopback requests with a loopback Host. A browser
Origin must be loopback too; an opaque Desktop Origin and origin-less local
CLI requests are supported. Forwarded headers never grant access. This mode
is for a trusted local installation, not a public reverse-proxy deployment or
shared LAN endpoint. All local clients use the same identity.

Authenticated API, WebSocket, workspace membership, Agent task identity, and
plugin authorization continue through their normal checks. The local entry
issues regular JWT/HttpOnly session cookies rather than accepting arbitrary
identity headers. Disabling the option removes the bootstrap entry; it does
not revoke sessions already issued through it.

## Managed development

`scripts/dev-env.sh` uses the local bootstrap when the option is enabled. Its
CLI profile, the optional daemon, and development Desktop use the same local
user/workspace as a fresh browser. A cached profile for the previous dev user
is replaced with a local-user profile. The original account data remains.
The managed environment still owns database names and port allocation.

## Verification

Backend coverage: the disabled entry, loopback/foreign-origin policy, real
identity and workspace bootstrap, authenticated `GetMe`, HttpOnly cookie
issuance, and repeated/concurrent bootstrap. Tests use the configured checkout
database through the managed environment; a missing DB must not be mistaken
for a passing integration run.

Frontend coverage: strict capability parsing, malformed credential rejection,
cookie/token storage, automatic entry, retryable errors, and root navigation.
The shared component/store tests cover the Desktop code path; an installed
Desktop build remains a separate acceptance check.

`e2e/local-auth.spec.ts` is enabled only when `MULTICA_LOCAL_AUTH=true`. Run it
against the managed environment:

```sh
make env-exec ARGS="-- pnpm exec playwright test local-auth.spec.ts"
```

It starts a browser context with no credentials, enters from `/`, creates an
issue through the UI (exercising the cookie/CSRF write path), reloads the issue,
and checks that the browser called only `/auth/local`. `TestApiClient` removes
the test issue afterwards. The test attaches a screenshot of the running app.
This workflow has passed on the local Web environment; packaged Desktop and
remote/LAN access are not included in that evidence.
