#!/bin/sh
# Local dev bootstrap for Bharat Insurance.
# Loads secrets from .env.local (git-ignored) into the environment, then
# starts vercel dev on :3000.
#
# Why a shell script and not `npm run dev`? `vercel dev` refuses to run from
# an npm script called `dev` — treats it as recursive invocation.
#
# Usage:  ./dev.sh

set -e

if [ ! -f .env.local ]; then
  echo "error: .env.local is missing. Copy the template values and try again." >&2
  exit 1
fi

# Load every KEY=VALUE line from .env.local (skip blanks + comments).
set -a
. ./.env.local
set +a

echo "Bharat Insurance — local dev"
echo "  SIMSON_BASE_URL      = $SIMSON_BASE_URL"
echo "  SIMSON_CLIENT_NAME   = $SIMSON_CLIENT_NAME"
echo "  SIMSON_USERNAME      = $SIMSON_USERNAME"
if [ -n "$ADMIN_PASS" ]; then echo "  ADMIN_PASS           = set"; else echo "  ADMIN_PASS           = not set"; fi
echo

exec vercel dev --listen 3000 --yes
