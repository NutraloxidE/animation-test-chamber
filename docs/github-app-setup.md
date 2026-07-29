# GitHub App setup (optional)

The chamber commits through the Fake Git Adapter by default and needs no GitHub
configuration. Follow this only when you want real commits and pull requests.

## 1. Create the App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

- **Homepage URL**: anything (it is not used)
- **Webhook**: uncheck *Active* — the chamber polls, it does not receive hooks
- **Repository permissions**:
  - Contents: **Read and write** (branches and commits)
  - Pull requests: **Read and write**
  - Metadata: **Read-only** (mandatory)
- **Where can this App be installed**: your account or organisation

No account permissions and no organisation permissions are required. Do not
grant Actions, Secrets, Administration or Workflows — the chamber never needs
them, and a smaller grant is a smaller blast radius.

## 2. Generate a private key

On the App's page, **Generate a private key**. A `.pem` downloads. Treat it as a
credential: it can act as the App on every repository the App is installed on.

## 3. Install it

**Install App** → choose the account → select **Only select repositories** and
pick the repository holding your chamber project.

The installation ID is the number at the end of the URL you land on:
`https://github.com/settings/installations/<INSTALLATION_ID>`.

## 4. Configure `.env`

```bash
GIT_ADAPTER=github
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=87654321
GITHUB_REPO_OWNER=your-name
GITHUB_REPO_NAME=your-repo
GITHUB_PROTECTED_BRANCH=main

# Paste the .pem contents. Either real newlines in quotes, or \n escapes —
# both are handled.
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----"
```

Restart the API server and check:

```bash
curl -s http://127.0.0.1:8787/api/health
```

`gitAdapter` should read `github` and `gitConfigured` should be `true`. If it
still reads `fake`, one of the five variables is missing — the adapter falls
back rather than starting in a half-configured state.

## Security notes

- `.env` is git-ignored, and the repo guard fails the build if a `.env` is ever
  committed or if a key-shaped string appears in the tree.
- The private key is read only by `apps/api`, which binds to `127.0.0.1`. The
  browser never receives a token; it calls `/api` and the server mints a
  short-lived installation token per request.
- The repo guard also fails if any file under `apps/web` references
  `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_ID` or `ANTHROPIC_API_KEY`.
- Direct commits to `GITHUB_PROTECTED_BRANCH` are refused by both adapters, and
  every commit requires the base SHA it was built on.

## What it does with the access

- Creates and updates branches named `chamber/<project>/<session-id>`
- Creates blobs, trees and commits on those branches
- Opens pull requests against the protected branch

It never force-pushes, never deletes branches, and never writes to the protected
branch.
