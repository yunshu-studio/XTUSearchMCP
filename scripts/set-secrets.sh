#!/usr/bin/env bash
set -euo pipefail
for key in ADMIN_USERNAME ADMIN_PASSWORD SESSION_SECRET MCP_TOKEN; do
  echo "Set $key"
  npx wrangler secret put "$key"
done
