param([string]$OutputDirectory = 'dist-desktop', [string]$CertificateManifest = $env:PLY_EVALUATION_MANIFEST)
$ErrorActionPreference = 'Stop'
if (!$CertificateManifest) { $CertificateManifest = Join-Path $env:LOCALAPPDATA 'Ply/signing/evaluation/certificate.json' }
$manifest = Get-Content -LiteralPath $CertificateManifest -Raw | ConvertFrom-Json
$certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$($manifest.thumbprint)"
if (!$certificate.HasPrivateKey -or $certificate.NotAfter -le (Get-Date)) { throw 'No valid evaluation signing key.' }
$env:PLY_WINDOWS_SIGNING = 'store'
$env:PLY_WIN_PUBLISHER = $manifest.publisher
$env:PLY_WIN_CERTIFICATE_SHA1 = $manifest.thumbprint
# Update feed baked into the app. Upload destination (GH_REPO) is chosen separately by publish-evaluation.ps1.
if (!$env:PLY_RELEASE_REPOSITORY) { $env:PLY_RELEASE_REPOSITORY = 'tekalu1/pleiad' }
& npm.cmd run desktop:dist -- --config electron-builder.release.cjs --win --x64 --publish never "--config.directories.output=$OutputDirectory"
if ($LASTEXITCODE -ne 0) { throw 'Evaluation build failed.' }
$artifacts = @((Get-ChildItem -LiteralPath $OutputDirectory -Filter '*.exe')) + @((Get-ChildItem -LiteralPath $OutputDirectory -Recurse -Filter 'Ply.exe'))
if ($artifacts.Count -lt 2) { throw 'Missing installer or packaged executable.' }
foreach ($artifact in $artifacts) {
  $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $manifest.thumbprint) { throw "Unexpected signature: $($artifact.Name)" }
}
Copy-Item -LiteralPath $manifest.publicCertificate -Destination (Join-Path $OutputDirectory 'Pleiad-Evaluation.cer')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'evaluation-certificate.ps1') -Destination (Join-Path $OutputDirectory 'evaluation-certificate.ps1')
[ordered]@{ publisher = $manifest.publisher; thumbprint = $manifest.thumbprint; expires = $manifest.expires; publicCertificate = 'Pleiad-Evaluation.cer'; privateKeyIncluded = $false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'SIGNING-INFO.json') -Encoding UTF8
Write-Output 'Evaluation installer and executable signatures verified.'
