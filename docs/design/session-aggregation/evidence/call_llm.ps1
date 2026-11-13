param(
  [Parameter(Mandatory=$true)][ValidateSet('openai','anthropic')][string]$Api,
  [Parameter(Mandatory=$true)][string]$BaseUrl,
  [Parameter(Mandatory=$true)][string]$Model,
  [Parameter(Mandatory=$true)][string]$PromptFile,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [Parameter(Mandatory=$true)][string]$KeyName,
  [int]$MaxTokens = 8000,
  [double]$Temperature = 0.2,
  [int]$TimeoutSec = 900
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-SecretValue([string]$name) {
  $envValue = [Environment]::GetEnvironmentVariable($name, 'User')
  if (-not $envValue) { $envValue = [Environment]::GetEnvironmentVariable($name, 'Process') }
  if ($envValue) { return $envValue }
  $cred = Get-Content "C:\Users\wwm_1\.dsh\.credentials.yaml" -Raw -Encoding UTF8
  $m = [regex]::Match($cred, "(?m)^\s*$name\s*:\s*'?([^'\r\n]+)'?\s*$")
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  throw "credential not found: $name"
}

$key = Get-SecretValue $KeyName
$prompt = [System.IO.File]::ReadAllText($PromptFile, [System.Text.Encoding]::UTF8)

if ($Api -eq 'openai') {
  $body = @{
    model = $Model
    messages = @(@{ role = "user"; content = $prompt })
    max_tokens = $MaxTokens
    temperature = $Temperature
    stream = $false
  } | ConvertTo-Json -Depth 8 -Compress
  $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/chat/completions" -Headers @{ Authorization = "Bearer $key" } -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec $TimeoutSec
  $content = $resp.choices[0].message.content
} else {
  $body = @{
    model = $Model
    max_tokens = $MaxTokens
    messages = @(@{ role = "user"; content = $prompt })
  } | ConvertTo-Json -Depth 8 -Compress
  $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/messages" -Headers @{
    "x-api-key" = $key
    "anthropic-version" = "2023-06-01"
  } -ContentType "application/json" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec $TimeoutSec
  $content = ($resp.content | Where-Object { $_.type -eq "text" } | ForEach-Object { $_.text }) -join ""
}

if (-not $content) { $content = ($resp | ConvertTo-Json -Depth 8 -Compress) }
[System.IO.File]::WriteAllText($OutFile, $content, [System.Text.UTF8Encoding]::new($false))
$usage = $resp.usage | ConvertTo-Json -Compress
"OK model=$Model chars=$($content.Length) usage=$usage out=$OutFile"
