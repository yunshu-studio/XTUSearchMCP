$ErrorActionPreference = "Stop"
Write-Host "Set ADMIN_USERNAME"
npx wrangler secret put ADMIN_USERNAME
Write-Host "Set ADMIN_PASSWORD"
npx wrangler secret put ADMIN_PASSWORD
Write-Host "Set SESSION_SECRET (建议 >=32 字节随机串)"
npx wrangler secret put SESSION_SECRET
Write-Host "Set MCP_TOKEN"
npx wrangler secret put MCP_TOKEN
