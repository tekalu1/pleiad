# Hand check of desktop/update-signature.cjs with the real koffi on this Windows PC.
# Creates a throw-away self-signed code-signing certificate in CurrentUser\My (NOT trusted by Windows), signs a copy of a tiny exe,
# runs the verifier against: allowed / not allowed fingerprint, a 1-byte-modified copy, an unsigned copy, and optionally a real release installer.
# Removes the certificate (Set-AuthenticodeSignature also caches it in CurrentUser\CA; removed too) and the copies when done.
# Never touches CurrentUser\Root or any existing certificate.
#   powershell -File scripts/verify-update-signature.ps1 [-Installer <path to a real signed installer>]
param([string]$Installer = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path ([IO.Path]::GetTempPath()) ('ply-sigcheck-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$cert = $null
function Check([string]$file, [string[]]$thumbs) {
  $json = & node (Join-Path $PSScriptRoot 'update-signature-check.cjs') $file @thumbs
  if ($LASTEXITCODE -ne 0) { throw "check failed for $file" }
  return $json | ConvertFrom-Json
}
function Show([string]$label, $r, [bool]$expectPinned) {
  $ok = ($r.pinned.ok -eq $expectPinned)
  Write-Output ("{0}: pinned.ok={1} (expected {2}) -> {3}; combined={4}; reason={5}" -f $label, $r.pinned.ok, $expectPinned, $(if ($ok) { 'PASS' } else { 'FAIL' }), $(if ($null -eq $r.combined) { 'accepted' } else { 'rejected' }), $r.pinned.reason)
  if (!$ok) { $script:failed = $true }
}
$failed = $false
try {
  $source = Join-Path $work 'tiny.cs'
  Set-Content -LiteralPath $source -Value 'class P { static void Main() { System.Console.WriteLine("ply"); } }' -Encoding ASCII
  $exe = Join-Path $work 'unsigned.exe'
  Add-Type -TypeDefinition (Get-Content -LiteralPath $source -Raw) -OutputAssembly $exe -OutputType ConsoleApplication
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject ('CN=Ply Update Signature Test ' + [guid]::NewGuid().ToString('N').Substring(0, 8)) -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(2)
  $thumb = $cert.Thumbprint
  Write-Output "test certificate: $thumb"
  $signed = Join-Path $work 'signed.exe'
  Copy-Item -LiteralPath $exe -Destination $signed
  Set-AuthenticodeSignature -FilePath $signed -Certificate $cert -HashAlgorithm SHA256 | Out-Null
  Write-Output "Get-AuthenticodeSignature status after signing: $((Get-AuthenticodeSignature -LiteralPath $signed).Status)"
  $other = 'BCEE9BE88BEE6BB94909FC74C0622420CAE50910'
  Show 'signed + fingerprint in list' (Check $signed @($thumb)) $true
  Show 'signed + lowercase fingerprint in list' (Check $signed @($thumb.ToLower())) $true
  Show 'signed + fingerprint NOT in list' (Check $signed @($other)) $false
  $tampered = Join-Path $work 'tampered.exe'
  $bytes = [IO.File]::ReadAllBytes($signed)
  $bytes[200] = $bytes[200] -bxor 0xFF   # inside the PE headers, covered by the digest
  [IO.File]::WriteAllBytes($tampered, $bytes)
  Show 'signed + 1 byte modified' (Check $tampered @($thumb)) $false
  Show 'unsigned' (Check $exe @($thumb)) $false
  if ($Installer) {
    $real = Check $Installer @()
    $s = Get-AuthenticodeSignature -LiteralPath $Installer
    Write-Output ("real installer: Get-AuthenticodeSignature={0}; combined={1}; pinned.reason={2}; timestamp={3}" -f $s.Status, $(if ($null -eq $real.combined) { 'accepted' } else { 'rejected' }), $real.pinned.reason, $(if ($s.TimeStamperCertificate) { $s.TimeStamperCertificate.Subject } else { 'none' }))
    if ($null -ne $real.combined) { $failed = $true }
  }
} finally {
  if ($cert) { foreach ($store in 'My', 'CA') { Remove-Item -LiteralPath ("Cert:\CurrentUser\$store\" + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue } }
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
if ($failed) { Write-Output 'RESULT: FAIL'; exit 1 }
Write-Output 'RESULT: PASS'
