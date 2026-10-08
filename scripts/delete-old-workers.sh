#!/usr/bin/env bash
set -euo pipefail
workers=(xtu-main-mcp xtu-jwc-mcp xtu-cs-mcp xtu-kjc-mcp xtu-jszy-mcp xtu-nic-mcp xtu-jiuye-mcp)
echo "先确认新 xtu-search-mcp 已验证可用。以下操作不可逆。"
read -r -p "输入 DELETE 继续: " confirm
[[ "$confirm" == "DELETE" ]] || exit 1
for name in "${workers[@]}"; do
  npx wrangler delete --name "$name"
done
