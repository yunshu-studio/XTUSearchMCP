$ErrorActionPreference = "Stop"
npx wrangler d1 create xtu-search-mcp
npx wrangler r2 bucket create xtu-search-mcp
npx wrangler queues create xtu-search-crawl
npx wrangler queues create xtu-search-crawl-dlq
npx wrangler vectorize create xtu-search-index --dimensions=1024 --metric=cosine
Write-Host "资源创建完成。把 D1 database_id 写入 wrangler.jsonc，然后执行 migrations 与 deploy。"
