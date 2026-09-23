param([switch]$Cleanup)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'This script is only for disposable GitHub-hosted runners.' }
if ($env:PLY_WIN_CERTIFICATE_SHA1 -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Missing evaluation certificate fingerprint.' }
$directory = Join-Path $env:RUNNER_TEMP 'ply-signing'
$pfx = Join-Path $directory 'certificate.pfx'
if ($Cleanup) {
  foreach ($store in @('CurrentUser\My', 'LocalMachine\Root')) {
    $path = "Cert:\$store\$env:PLY_WIN_CERTIFICATE_SHA1"
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
  }
  if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx }
  return
}
if (!$env:PLY_EVALUATION_PFX -or !$env:PLY_EVALUATION_PASSWORD -or !$env:PLY_WIN_PUBLISHER) { throw 'Missing evaluation signing secrets or publisher.' }
New-Item -ItemType Directory -Force -Path $directory | Out-Null
try {
  [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:PLY_EVALUATION_PFX))
  $password = ConvertTo-SecureString $env:PLY_EVALUATION_PASSWORD -AsPlainText -Force
  $certificates = @(Import-PfxCertificate -FilePath $pfx -CertStoreLocation 'Cert:\CurrentUser\My' -Password $password)
  if ($certificates.Count -ne 1) { throw 'Expected exactly one signing certificate.' }
  $certificate = $certificates[0]
  if (!$certificate.HasPrivateKey -or $certificate.Thumbprint -ne $env:PLY_WIN_CERTIFICATE_SHA1 -or $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne $env:PLY_WIN_PUBLISHER) { throw 'Unexpected signing identity.' }
  $publicFile = Join-Path $directory 'Ply-Evaluation.cer'
  Export-Certificate -Cert $certificate -FilePath $publicFile -Force | Out-Null
  & "$PSScriptRoot/evaluation-certificate.ps1" -Action Trust -CertificateFile $publicFile -ExpectedThumbprint $env:PLY_WIN_CERTIFICATE_SHA1 -DisposableRunner
  $env:PLY_EVALUATION_MANIFEST = Join-Path $directory 'certificate.json'
  [ordered]@{ publisher = $env:PLY_WIN_PUBLISHER; thumbprint = $certificate.Thumbprint; expires = $certificate.NotAfter.ToUniversalTime().ToString('o'); publicCertificate = $publicFile } | ConvertTo-Json | Set-Content -LiteralPath $env:PLY_EVALUATION_MANIFEST -Encoding UTF8
} finally {
  if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx }
  $env:PLY_EVALUATION_PFX = $null
  $env:PLY_EVALUATION_PASSWORD = $null
}
