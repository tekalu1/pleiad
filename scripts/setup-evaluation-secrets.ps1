param([string]$Repository = 'tekalu1/pleiad')
$ErrorActionPreference = 'Stop'
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid repository.' }
& gh.exe repo view $Repository --json name | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Signing repository is not accessible.' }

function Set-Secret([string]$Name, [string]$Value) {
  # Keep secret values out of command arguments, files and console output.
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = (Get-Command gh.exe).Source
  $info.Arguments = "secret set $Name --repo $Repository"
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  # The redirected stdin writer takes Console.InputEncoding, whose UTF-8 default prepends a BOM to the secret.
  $inputEncoding = [Console]::InputEncoding
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
  try { $process = [System.Diagnostics.Process]::Start($info) } finally { [Console]::InputEncoding = $inputEncoding }
  try {
    $process.StandardInput.Write($Value)
    $process.StandardInput.Close()
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "GitHub secret registration failed: $Name" }
  } finally { $process.Dispose() }
}

# Keep the existing non-exportable evaluation identity intact.
$directory = Join-Path $env:LOCALAPPDATA 'Ply/signing/github-evaluation'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$manifestFile = Join-Path $directory 'certificate.json'
if (Test-Path -LiteralPath $manifestFile) {
  $saved = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
  $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$($saved.thumbprint)"
  if (!$certificate.HasPrivateKey -or $certificate.NotAfter -lt (Get-Date).AddDays(30)) { throw 'Signing identity is missing or expiring; rotate it deliberately.' }
} else {
  # Installed apps verify updates against this publisher name (CN). Keep it unchanged when rotating keys.
  $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Ply Evaluation (hikaru)' -FriendlyName 'Ply GitHub evaluation code signing' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(1)
}
$publicFile = Join-Path $directory 'Ply-Evaluation.cer'
Export-Certificate -Cert $certificate -FilePath $publicFile -Force | Out-Null
$publisher = $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
[ordered]@{ publisher = $publisher; thumbprint = $certificate.Thumbprint; expires = $certificate.NotAfter.ToUniversalTime().ToString('o'); publicCertificate = $publicFile; privateKey = 'CurrentUser/My and encrypted PFX in GitHub Actions Secrets' } | ConvertTo-Json | Set-Content -LiteralPath $manifestFile -Encoding UTF8
$random = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $rng.GetBytes($random)
  $password = [Convert]::ToBase64String($random)
  $pfx = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password)
  Set-Secret 'WIN_CSC_LINK' ([Convert]::ToBase64String($pfx))
  Set-Secret 'WIN_CSC_KEY_PASSWORD' $password
} finally {
  $rng.Dispose()
  [Array]::Clear($random, 0, $random.Length)
  if ($pfx) { [Array]::Clear($pfx, 0, $pfx.Length) }
  $password = $null
}
& gh.exe variable set PLY_WIN_PUBLISHER --repo $Repository --body $publisher
if ($LASTEXITCODE -ne 0) { throw 'Publisher registration failed.' }
& gh.exe variable set PLY_WIN_CERTIFICATE_SHA1 --repo $Repository --body $certificate.Thumbprint
if ($LASTEXITCODE -ne 0) { throw 'Fingerprint registration failed.' }
& "$PSScriptRoot/evaluation-certificate.ps1" -Action Trust -CertificateFile $publicFile -ExpectedThumbprint $certificate.Thumbprint
Write-Output "GitHub evaluation signing configured for $Repository. Public fingerprint: $($certificate.Thumbprint)"
