param(
  [string]$Token = ""
)

$ErrorActionPreference = "Continue"
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $Dir

# 1) Token: from -Token arg, else from token.txt
if (-not $Token) {
  if (Test-Path "token.txt") { $Token = (Get-Content "token.txt" -Raw).Trim() }
}
if (-not $Token) {
  Write-Host "ERROR: token not found. Put your PAT in token.txt or run:"
  Write-Host "  powershell -File deploy.ps1 -Token ghp_xxx"
  exit 1
}

$headers = @{ Authorization = "Bearer $Token"; "Content-Type" = "application/json" }
$api = "https://api.github.com"
$repo = "my-workbench"

# 2) Get GitHub login
try {
  $me = Invoke-RestMethod -Uri "$api/user" -Headers $headers -Method Get
  $login = $me.login
} catch {
  Write-Host "ERROR: cannot reach GitHub or token invalid: $_"
  exit 1
}
Write-Host "GitHub user: $login"

# 3) Create public repo (ignore if it already exists)
$body = @{ name = $repo; description = "My Workbench - personal habit & study PWA"; public = $true; auto_init = $false } | ConvertTo-Json
try {
  Invoke-RestMethod -Uri "$api/user/repos" -Headers $headers -Method Post -Body $body | Out-Null
  Write-Host "Repository created."
} catch {
  $msg = $_.Exception.Message
  if ($msg -like "*422*") { Write-Host "Repository already exists, continue." }
  else { Write-Host "Create repo warning: $msg" }
}

# 4) Upload all files via Contents API (works on empty repos, auto-creates branch)
$files = @(
  "index.html","style.css","app.js","manifest.json","sw.js",
  "icon-192.png","icon-512.png","apple-touch-icon.png",
  "supabase_schema.sql","supabase.min.js",".nojekyll",".gitignore",
  "deploy.bat","deploy.ps1"
)

Write-Host "Uploading $($files.Count) files..."
foreach ($f in $files) {
  if (-not (Test-Path $f)) { Write-Host "  skip (missing): $f"; continue }
  $bytes = [System.IO.File]::ReadAllBytes($f)
  $b64 = [Convert]::ToBase64String($bytes)
  $putUrl = "$api/repos/$login/$repo/contents/" + [Uri]::EscapeDataString($f)
  try {
    $b = @{ message = "Add $f"; content = $b64; branch = "main" } | ConvertTo-Json
    Invoke-RestMethod -Uri $putUrl -Headers $headers -Method Put -Body $b | Out-Null
    Write-Host "  uploaded: $f"
  } catch {
    $msg = $_.Exception.Message
    if ($msg -like "*422*" -or $msg -like "*sha*") {
      # file already exists -> fetch its sha then update
      try {
        $existing = Invoke-RestMethod -Uri $putUrl -Headers $headers -Method Get
        $b2 = @{ message = "Update $f"; content = $b64; branch = "main"; sha = $existing.sha } | ConvertTo-Json
        Invoke-RestMethod -Uri $putUrl -Headers $headers -Method Put -Body $b2 | Out-Null
        Write-Host "  updated: $f"
      } catch {
        Write-Host "  FAILED (update) $f : $_"
      }
    } else {
      Write-Host "  FAILED $f : $msg"
    }
  }
}

# 5) Enable GitHub Pages
$pagesBody = @{ source = @{ branch = "main"; path = "/" } } | ConvertTo-Json -Depth 3
try {
  Invoke-RestMethod -Uri "$api/repos/$login/$repo/pages" -Headers $headers -Method Post -Body $pagesBody | Out-Null
  Write-Host "GitHub Pages enabled."
} catch {
  $msg = $_.Exception.Message
  if ($msg -like "*409*") { Write-Host "GitHub Pages already enabled." }
  else { Write-Host "Pages warning: $msg" }
}

Write-Host ""
Write-Host "DONE. Your site will be live at: https://$login.github.io/$repo/"
Write-Host "Note: GitHub Pages first build takes 1-2 minutes, then refresh."
Write-Host "Remember to delete token.txt and revoke the PAT on GitHub afterwards."
