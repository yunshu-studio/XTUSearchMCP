$workers = @(
  "xtu-main-mcp",
  "xtu-jwc-mcp",
  "xtu-cs-mcp",
  "xtu-kjc-mcp",
  "xtu-jszy-mcp",
  "xtu-nic-mcp",
  "xtu-jiuye-mcp"
)
Write-Host "先确认新 xtu-search-mcp 已验证可用。以下操作不可逆。" -ForegroundColor Yellow
$confirm = Read-Host "输入 DELETE 继续"
if ($confirm -ne "DELETE") { exit 1 }
foreach ($name in $workers) {
  npx wrangler delete --name $name
}
