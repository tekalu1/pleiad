param([Parameter(Mandatory = $true)][string]$Tag)
$ErrorActionPreference = 'Stop'
$package = Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json
if ($Tag -notmatch '^v\d+\.\d+\.\d+-beta\.\d+$' -or $Tag -cne "v$($package.version)") { throw 'Evaluation tag must match the beta package version.' }
if (!$env:GH_TOKEN -or !$env:GITHUB_REPOSITORY) { throw 'Run from the evaluation release workflow.' }
$env:RELEASE_TAG = $Tag
$env:GH_REPO = $env:GITHUB_REPOSITORY
if (git status --porcelain --untracked-files=no) { throw 'Tracked source files must be clean before packaging.' }
$source = (& git rev-parse HEAD).Trim()
$tagSource = (& git rev-parse "$Tag^{commit}").Trim()
if ($LASTEXITCODE -ne 0 -or $source -ne $tagSource) { throw 'Checkout must match the source tag.' }
if (Test-Path -LiteralPath release-assets) { throw 'Use a fresh release checkout.' }
& "$PSScriptRoot/build-evaluation.ps1" -OutputDirectory dist-desktop
if ($LASTEXITCODE -ne 0) { throw 'Signed build failed.' }
New-Item -ItemType Directory -Path release-assets | Out-Null
$names = Get-ChildItem -LiteralPath dist-desktop -File | Where-Object { $_.Name -match '\.(exe|blockmap)$' -or $_.Name -in @('latest.yml','Pleiad-Evaluation.cer','evaluation-certificate.ps1','SIGNING-INFO.json') }
foreach ($file in $names) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path release-assets $file.Name) }
[ordered]@{ version = $package.version; sourceCommit = $source; signing = 'self-signed evaluation'; runUrl = "https://github.com/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID" } | ConvertTo-Json | Set-Content -LiteralPath release-assets/BUILD-INFO.json -Encoding UTF8
& node.exe scripts/release-artifacts.mjs release-assets $package.version 100 temporary/release-notes.md windows
if ($LASTEXITCODE -ne 0) { throw 'Release integrity check failed.' }
& node.exe scripts/release-publish.mjs draft release-assets
if ($LASTEXITCODE -ne 0) { throw 'Draft creation failed.' }
# Verify the uploaded bytes before exposing this version to the updater.
& gh.exe release download $Tag --repo $env:GH_REPO --dir release-download
if ($LASTEXITCODE -ne 0) { throw 'Uploaded release could not be downloaded for verification.' }
foreach ($file in (Get-ChildItem -LiteralPath release-assets -File)) {
  $download = Join-Path release-download $file.Name
  if (!(Test-Path -LiteralPath $download) -or (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw "Uploaded bytes differ: $($file.Name)" }
}
& node.exe scripts/release-publish.mjs publish release-assets
if ($LASTEXITCODE -ne 0) { throw 'Publication failed; inspect the draft before retrying.' }
Write-Output "Published https://github.com/$env:GH_REPO/releases/tag/$Tag"
