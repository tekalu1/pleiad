param(
  [ValidateSet('Create', 'Trust')][string]$Action = 'Create',
  [string]$CertificateFile,
  [string]$ExpectedThumbprint,
  [switch]$DisposableRunner
)
$ErrorActionPreference = 'Stop'
if ($Action -eq 'Create') {
  $directory = Join-Path $env:LOCALAPPDATA 'Ply/signing/evaluation'
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $manifestFile = Join-Path $directory 'certificate.json'
  if (Test-Path -LiteralPath $manifestFile) {
    $saved = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$($saved.thumbprint)"
    if (!$certificate.HasPrivateKey -or $certificate.NotAfter -lt (Get-Date).AddDays(30)) { throw 'Evaluation certificate is missing its private key or expiring. Create a new identity deliberately.' }
  } else {
    # Installed apps verify updates against this publisher name (CN). Keep it unchanged when rotating keys.
    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Ply Evaluation (hikaru)' -FriendlyName 'Ply evaluation code signing' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(1)
  }
  $publicFile = Join-Path $directory 'Ply-Evaluation.cer'
  Export-Certificate -Cert $certificate -FilePath $publicFile -Force | Out-Null
  $manifest = [ordered]@{ publisher = $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false); thumbprint = $certificate.Thumbprint; expires = $certificate.NotAfter.ToUniversalTime().ToString('o'); publicCertificate = $publicFile; privateKey = 'CurrentUser/My; non-exportable' }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestFile -Encoding UTF8
  $manifest | ConvertTo-Json
} else {
  if (!$CertificateFile -or $ExpectedThumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Trust requires a public .cer and a separately verified ExpectedThumbprint.' }
  if ([IO.Path]::GetExtension($CertificateFile) -ne '.cer') { throw 'Only public .cer certificates are accepted.' }
  $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2((Resolve-Path -LiteralPath $CertificateFile).Path)
  if ($certificate.HasPrivateKey -or $certificate.Thumbprint -ne $ExpectedThumbprint -or $certificate.Subject -ne $certificate.Issuer) { throw 'Unexpected certificate identity or private key.' }
  if ($certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -le (Get-Date)) { throw 'Certificate is not currently valid.' }
  $eku = @($certificate.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } | ForEach-Object { $_.EnhancedKeyUsages } | ForEach-Object { $_.Value })
  if ($eku.Count -ne 1 -or $eku[0] -ne '1.3.6.1.5.5.7.3.3') { throw 'Certificate must be restricted to code signing.' }
  # GitHub's disposable Windows runner has administrator rights. The machine
  # store avoids an interactive CurrentUser root confirmation in a CI session.
  $store = 'Cert:\CurrentUser\Root'
  if ($DisposableRunner) {
    if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'Machine trust is restricted to disposable CI runners.' }
    $store = 'Cert:\LocalMachine\Root'
  }
  Import-Certificate -FilePath (Resolve-Path -LiteralPath $CertificateFile).Path -CertStoreLocation $store | Out-Null
  Write-Output "Trusted evaluation certificate in ${store}: $($certificate.Thumbprint)"
}
