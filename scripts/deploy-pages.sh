#!/usr/bin/env bash
# Deploy the built site to its Cloudflare Pages projects, from the machine that
# holds the credential.
#
# This exists because the failure mode is not "deploy failed" but "deploy failed
# for a reason wrangler will not tell you". A Cloudflare account-owned token
# (`cfat_…`) that has passed its expiry answers every wrangler command with
# `Authentication error [10000]` on the real endpoint and `Invalid access token
# [9109]` on `/accounts` — which reads as a permissions or account-id problem and
# sends you looking in the wrong place. Cloudflare will say plainly that the token
# expired, but only if you ask the verify endpoint. So that is asked first, and
# its answer is printed, before anything is uploaded.
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
token="${CLOUDFLARE_API_TOKEN:-}"
if [[ -z "$token" ]]; then
  # The token lives in the shell profile, which returns early for a
  # non-interactive shell — so the one line is sourced rather than the file.
  token="$(sed -n 's/^export CLOUDFLARE_API_TOKEN=//p' "$HOME/.bashrc" 2>/dev/null | head -1 | tr -d "\"' ")"
fi
if [[ -z "$token" ]]; then
  echo "no CLOUDFLARE_API_TOKEN found in the environment or ~/.bashrc" >&2
  exit 2
fi
# Account-owned tokens verify per account; `/user/tokens/verify` rejects them by
# design, which is not evidence of anything.
body="$(curl -sS --max-time 30 -H "Authorization: Bearer $token" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/tokens/verify")"
status="$(printf %s "$body" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
id="$(printf %s "$body" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
expires="$(printf %s "$body" | sed -n 's/.*"expires_on":"\([^"]*\)".*/\1/p')"
echo "token id=${id:-?} status=${status:-unknown} expires_on=${expires:-none}"
if [[ "$status" != "active" ]]; then
  echo "" >&2
  echo "This token cannot deploy. Renew it in the Cloudflare dashboard" >&2
  echo "(My Profile / Account API Tokens -> the token above -> extend expiry, or" >&2
  echo "create a new one with Pages:Edit on account $CF_ACCOUNT_ID), then update" >&2
  echo "CLOUDFLARE_API_TOKEN. Nothing was uploaded." >&2
  exit 3
fi
REMOTE

echo "syncing dist to $DEPLOY_HOST:~/$DEPLOY_DIR ..."
rsync -a --delete -e 'ssh -o ProxyJump=none' "$repo_root/dist/" "$DEPLOY_HOST:~/$DEPLOY_DIR/"

for project in $PAGES_PROJECTS; do
  echo "deploying $project ..."
  "${SSH[@]}" "DEPLOY_DIR=$DEPLOY_DIR PROJECT=$project BRANCH=$PAGES_BRANCH WRANGLER=$WRANGLER CF_ACCOUNT_ID=$CF_ACCOUNT_ID bash -s" <<'REMOTE'
set -euo pipefail
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-$(sed -n 's/^export CLOUDFLARE_API_TOKEN=//p' "$HOME/.bashrc" | head -1 | tr -d "\"' ")}"
cd "$HOME/$DEPLOY_DIR"
npx -y "$WRANGLER" pages deploy . --project-name "$PROJECT" --branch "$BRANCH"
REMOTE
done

echo
echo "deployed. verify with:"
for project in $PAGES_PROJECTS; do
  echo "  VERIFY_PROXY=http://127.0.0.1:10808 node scripts/verify-migration.mjs https://$project.pages.dev /tmp/$project-mig"
  echo "  VERIFY_PROXY=http://127.0.0.1:10808 node scripts/verify-orbit-lab.mjs  https://$project.pages.dev /tmp/$project-ol"
done
