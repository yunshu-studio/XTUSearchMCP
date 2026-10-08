param(
  [string]$Url = "https://xtu-search.nether.top/mcp",
  [Parameter(Mandatory=$true)][string]$Token,
  [string]$Query = ""
)

$headers = @{ Authorization = "Bearer $Token" }

function Invoke-Mcp([int]$Id, [string]$Method, $Params) {
  $payload = @{ jsonrpc = "2.0"; id = $Id; method = $Method; params = $Params } | ConvertTo-Json -Depth 20 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  Invoke-RestMethod -Uri $Url -Method Post -Headers $headers -ContentType "application/json; charset=utf-8" -Body $bytes
}

Write-Host "== initialize ==" -ForegroundColor Cyan
Invoke-Mcp 1 "initialize" @{ protocolVersion = "2025-03-26"; capabilities = @{}; clientInfo = @{ name = "xtu-mcp-test-v23"; version = "1.0" } } | ConvertTo-Json -Depth 10

Write-Host "`n== tools/list ==" -ForegroundColor Cyan
$tools = Invoke-Mcp 2 "tools/list" @{}
$tools.result.tools | Select-Object name, description | Format-List

Write-Host "`n== list_sources ==" -ForegroundColor Cyan
$sources = Invoke-Mcp 3 "tools/call" @{ name = "list_sources"; arguments = @{} }
$sources.result.content[0].text

Write-Host "`n== live search: $Query ==" -ForegroundColor Cyan
$search = Invoke-Mcp 4 "tools/call" @{ name = "search"; arguments = @{ query = $Query; mode = "live"; limit = 10 } }
$search.result.content[0].text

Write-Host "`n== source-name search:  ==" -ForegroundColor Cyan
$search2 = Invoke-Mcp 5 "tools/call" @{ name = "search"; arguments = @{ query = ""; sources = @(""); mode = "live"; limit = 5 } }
$search2.result.content[0].text
