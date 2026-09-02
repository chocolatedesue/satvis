#!/usr/bin/env bash
# Deploy the built site to its Cloudflare Pages projects, from the machine that
# holds the credential.
#
# This exists because the failure mode is not "deploy failed" but "deploy failed
# for a reason wrangler will not tell you". Cloudflare has three credential shapes
# and the prefix is the only thing that says which you hold:
#
#   cfk_   Global API Key    — authenticates with CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY
#   cfut_  User API Token    — bearer
#   cfat_  Account API Token — bearer
#   (pre-2026 tokens are unprefixed 40-character strings, still bearer)
#   https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/
#
# Send a cfk_ key as a bearer token and every endpoint answers `Invalid API Token`
# / `Authentication error`, which reads as an expired or under-scoped token and
# sends you looking in the wrong place entirely. An expired token is also
# indistinguishable from an unrecognised one through wrangler. Cloudflare will say
# plainly which it is, but only if the right endpoint is asked with the right
# scheme. So that is asked first, and its answer printed, before anything uploads.
#
# Two projects, one artifact: `lab58-inertial-frame` is a strict superset of
# `lab58-orbit-lab`, so both Pages projects serve the same build. Deploying only
# one is how `satvis-orbit-lab` came to sit on a stale bundle still exhibiting a
# bug that had already been fixed.
#
#   pnpm build && scripts/deploy-pages.sh
#
# Overridable: DEPLOY_HOST, DEPLOY_DIR, CF_ACCOUNT_ID, PAGES_PROJECTS, PAGES_BRANCH.

set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-yqh2}"
DEPLOY_DIR="${DEPLOY_DIR:-satvis-lab58-inertial-dist}"
CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-4272b137f5db89616a76fd1d1b3c85e2}"
PAGES_PROJECTS="${PAGES_PROJECTS:-satvis-inertial-frame satvis-orbit-lab}"
PAGES_BRANCH="${PAGES_BRANCH:-main}"
WRANGLER="${WRANGLER:-wrangler@4.127.0}"

# yqh2 is reachable directly over the tailnet; its `ProxyJump yqh1` hop goes
# through an hsvpn forward that is not always up, and a jump that can drop is a
# dependency this does not need.
SSH=(ssh -o ProxyJump=none "$DEPLOY_HOST")

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -f "$repo_root/dist/index.html" ]]; then
  echo "no build to deploy: run 'pnpm build' first" >&2
  exit 1
fi

# What is about to be deployed, named by its own stamp. A `-dirty` suffix means
# the build carries changes no commit contains — see vite.config.ts.
stamp="$(grep -ohm1 'build:`[^`]*`' "$repo_root"/dist/assets/cesium-*.js 2>/dev/null | head -1 || true)"
echo "deploying ${stamp:-<no stamp found>}"
case "$stamp" in
  *-dirty*) echo "warning: this build's tree is not the commit it names" >&2 ;;
esac

# Ask Cloudflare about the credential before uploading anything, and print what it
# says. `success:true` with `status:expired` is the case worth catching: the API
# call itself works, so only the token's own status reveals the problem.
echo "checking the credential on $DEPLOY_HOST ..."
"${SSH[@]}" "CF_ACCOUNT_ID=$CF_ACCOUNT_ID bash -s" <<'REMOTE'
set -euo pipefail
secrets="$HOME/.secrets/cloudflare-pages.env"
[[ -r "$secrets" ]] && . "$secrets"

# Which of the three credential shapes is in hand. The prefix says: `cfk_` is a
# Global API Key and authenticates with email + key headers; `cfut_`/`cfat_` and the
# pre-2026 unprefixed 40-character strings are tokens and use a bearer header.
# https://developers.cloudflare.com/fundamentals/api/get-started/token-formats/
key="${CLOUDFLARE_API_KEY:-}"
email="${CLOUDFLARE_EMAIL:-}"
token="${CLOUDFLARE_API_TOKEN:-}"

if [[ -n "$key" && -n "$email" ]]; then
  body="$(curl -sS --max-time 30 -H "X-Auth-Email: $email" -H "X-Auth-Key: $key" \
    "https://api.cloudflare.com/client/v4/user")"
  if ! printf %s "$body" | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
    echo "Global API Key rejected for $email" >&2
    echo "  cloudflare said: $(printf %s "$body" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')" >&2
    echo "  9103 means the key and the email do not go together — check both." >&2
    echo "Nothing was uploaded." >&2
    exit 3
  fi
  echo "global API key OK for $email"
  # Access is a separate question from authenticity: the key is user-wide, so
  # confirm this account's Pages is actually reachable before uploading to it.
  projects="$(curl -sS --max-time 30 -H "X-Auth-Email: $email" -H "X-Auth-Key: $key" \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects")"
  if ! printf %s "$projects" | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
    echo "key authenticates but cannot read Pages on account $CF_ACCOUNT_ID" >&2
    echo "  cloudflare said: $(printf %s "$projects" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')" >&2
    exit 3
  fi
  echo "pages reachable on account $CF_ACCOUNT_ID"
  exit 0
fi

if [[ -z "$token" ]]; then
  # Older location: the shell profile, which returns early for a non-interactive
  # shell — so the one line is sourced rather than the file.
  token="$(sed -n 's/^export CLOUDFLARE_API_TOKEN=//p' "$HOME/.bashrc" 2>/dev/null | head -1 | tr -d "\"' ")"
fi
if [[ -z "$token" ]]; then
  echo "no credential found: set CLOUDFLARE_EMAIL+CLOUDFLARE_API_KEY (cfk_) or" >&2
  echo "CLOUDFLARE_API_TOKEN (cfut_/cfat_) in ~/.secrets/cloudflare-pages.env" >&2
  exit 2
fi
if [[ "$token" == cfk_* ]]; then
  echo "CLOUDFLARE_API_TOKEN holds a cfk_ value, which is a Global API Key, not a token." >&2
  echo "It will never authenticate as a bearer token. Set it as CLOUDFLARE_API_KEY" >&2
  echo "alongside CLOUDFLARE_EMAIL instead." >&2
  exit 3
fi
# Account-owned tokens verify per account; `/user/tokens/verify` rejects them by
# design, which is not evidence of anything.
body="$(curl -sS --max-time 30 -H "Authorization: Bearer $token" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/tokens/verify")"
status="$(printf %s "$body" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
id="$(printf %s "$body" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
expires="$(printf %s "$body" | sed -n 's/.*"expires_on":"\([^"]*\)".*/\1/p')"
if [[ -n "$status" ]]; then
  # Cloudflare knows this token: it answers with the token's own id and state, so
  # `expired` is distinguishable from a scope problem.
  echo "token id=${id:-?} status=$status expires_on=${expires:-none}"
else
  # No status means Cloudflare did not recognise the value as a token for this
  # account at all — a different failure from an expired one, and worth saying so,
  # because wrangler renders both as the same `Authentication error`.
  echo "token NOT RECOGNISED for account $CF_ACCOUNT_ID"
  echo "  cloudflare said: $(printf %s "$body" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')"
  echo "  (an expired token would instead report its id and status=expired here)"
  status="unrecognised"
fi
if [[ "$status" != "active" ]]; then
  echo "" >&2
  echo "This token cannot deploy. Create or renew one in the Cloudflare dashboard:" >&2
  echo "  Account API Tokens (or My Profile / API Tokens) -> Pages:Edit on account" >&2
  echo "  $CF_ACCOUNT_ID. A usable value is 40 chars, or 'cfat_' + 48." >&2
  echo "Then put it in ~/.secrets/cloudflare-pages.env as CLOUDFLARE_API_TOKEN=..." >&2
  echo "Nothing was uploaded." >&2
  exit 3
fi
REMOTE

echo "syncing dist to $DEPLOY_HOST:~/$DEPLOY_DIR ..."
rsync -a --delete -e 'ssh -o ProxyJump=none' "$repo_root/dist/" "$DEPLOY_HOST:~/$DEPLOY_DIR/"

for project in $PAGES_PROJECTS; do
  echo "deploying $project ..."
  "${SSH[@]}" "DEPLOY_DIR=$DEPLOY_DIR PROJECT=$project BRANCH=$PAGES_BRANCH WRANGLER=$WRANGLER CF_ACCOUNT_ID=$CF_ACCOUNT_ID bash -s" <<'REMOTE'
set -euo pipefail
secrets="$HOME/.secrets/cloudflare-pages.env"
[[ -r "$secrets" ]] && . "$secrets"
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
if [[ -n "${CLOUDFLARE_API_KEY:-}" && -n "${CLOUDFLARE_EMAIL:-}" ]]; then
  # Global API Key: wrangler reads this pair as its legacy global auth. The token
  # variable has to stay unset — wrangler prefers a token when both are present, and
  # a cfk_ value is not one.
  unset CLOUDFLARE_API_TOKEN
  export CLOUDFLARE_EMAIL CLOUDFLARE_API_KEY
elif [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  CLOUDFLARE_API_TOKEN="$(sed -n 's/^export CLOUDFLARE_API_TOKEN=//p' "$HOME/.bashrc" | head -1 | tr -d "\"' ")"
  export CLOUDFLARE_API_TOKEN
fi
cd "$HOME/$DEPLOY_DIR"
# Prefer a wrangler already installed on the host: `npx -y wrangler@<version>`
# downloads ~50 MB from npm on first use, and on a host with slow or filtered
# egress that download is where a deploy hangs — long after the credential
# checks passed, with no error to read. A preinstalled binary is instant.
WRANGLER_BIN="$(command -v wrangler 2>/dev/null || true)"
if [[ -z "$WRANGLER_BIN" ]]; then
  WRANGLER_BIN="$(ls -t "$HOME"/.local/share/mise/installs/node/*/bin/wrangler 2>/dev/null | head -1 || true)"
fi
if [[ -n "$WRANGLER_BIN" ]]; then
  echo "using preinstalled wrangler: $WRANGLER_BIN"
  "$WRANGLER_BIN" pages deploy . --project-name "$PROJECT" --branch "$BRANCH"
else
  echo "no preinstalled wrangler found; falling back to npx $WRANGLER"
  npx -y "$WRANGLER" pages deploy . --project-name "$PROJECT" --branch "$BRANCH"
fi
REMOTE
done

echo
echo "deployed. verify with:"
for project in $PAGES_PROJECTS; do
  echo "  VERIFY_PROXY=http://127.0.0.1:10808 node scripts/verify-migration.mjs https://$project.pages.dev /tmp/$project-mig"
  echo "  VERIFY_PROXY=http://127.0.0.1:10808 node scripts/verify-orbit-lab.mjs  https://$project.pages.dev /tmp/$project-ol"
  echo "  VERIFY_PROXY=http://127.0.0.1:10808 node scripts/verify-links.mjs      https://$project.pages.dev /tmp/$project-links"
done
