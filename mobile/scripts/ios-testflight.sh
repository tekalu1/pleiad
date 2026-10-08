#!/bin/bash
# 登録後の配布用。秘密はランナーの一時領域だけに復元し、終了時に消す。
set -euo pipefail
umask 077
work=$(mktemp -d "$RUNNER_TEMP/pleiad-ios.XXXXXX")
keychain="$work/signing.keychain-db"
profile_path=''
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  if [ -n "$profile_path" ]; then rm -f "$profile_path"; fi
  rm -rf "$work"
}
trap cleanup EXIT
export IOS_SIGNING_WORK="$work"
python3 - <<'PY'
import base64, os
from pathlib import Path
work = Path(os.environ['IOS_SIGNING_WORK'])
for env, name in [('IOS_DISTRIBUTION_P12_BASE64', 'distribution.p12'),
                  ('IOS_PROVISION_PROFILE_BASE64', 'profile.mobileprovision'),
                  ('ASC_PRIVATE_KEY_BASE64', 'AuthKey.p8')]:
    (work / name).write_bytes(base64.b64decode(os.environ[env], validate=True))
PY
security cms -D -i "$work/profile.mobileprovision" > "$work/profile.plist"
profile_uuid=$(/usr/libexec/PlistBuddy -c 'Print UUID' "$work/profile.plist")
profile_name=$(/usr/libexec/PlistBuddy -c 'Print Name' "$work/profile.plist")
profile_dir="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p "$profile_dir"
profile_path="$profile_dir/$profile_uuid.mobileprovision"
cp "$work/profile.mobileprovision" "$profile_path"
keychain_password=$(openssl rand -hex 24)
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/distribution.p12" -k "$keychain" -P "$IOS_DISTRIBUTION_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
export IOS_PROFILE_NAME="$profile_name"
python3 - <<'PY'
import os, plistlib
from pathlib import Path
p = Path(os.environ['IOS_SIGNING_WORK'])
profile = plistlib.loads((p / 'profile.plist').read_bytes())
team = os.environ['IOS_TEAM_ID']
app = profile['Entitlements']['application-identifier']
prefix = profile['ApplicationIdentifierPrefix'][0] + '.'
if not app.startswith(prefix) or '*' in app:
    raise SystemExit('Use a profile for an explicit Bundle ID')
bundle = app[len(prefix):]
if team not in profile['TeamIdentifier']:
    raise SystemExit('Profile team mismatch')
(p / 'bundle-id').write_text(bundle)
(p / 'ExportOptions.plist').write_bytes(plistlib.dumps({
    'method': 'app-store-connect', 'destination': 'upload', 'teamID': team,
    'signingStyle': 'manual', 'signingCertificate': 'Apple Distribution',
    'provisioningProfiles': {bundle: os.environ['IOS_PROFILE_NAME']},
    'manageAppVersionAndBuildNumber': False, 'uploadSymbols': True,
}))
PY
bundle_id=$(cat "$work/bundle-id")
xcodebuild archive -project mobile/ios/App/App.xcodeproj -scheme App \
  -configuration Release -destination 'generic/platform=iOS' -archivePath "$work/App.xcarchive" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY='Apple Distribution' \
  DEVELOPMENT_TEAM="$IOS_TEAM_ID" PROVISIONING_PROFILE_SPECIFIER="$profile_name" \
  PRODUCT_BUNDLE_IDENTIFIER="$bundle_id" CURRENT_PROJECT_VERSION="$GITHUB_RUN_NUMBER.$GITHUB_RUN_ATTEMPT"
xcodebuild -exportArchive -archivePath "$work/App.xcarchive" -exportOptionsPlist "$work/ExportOptions.plist" \
  -exportPath "$work/export" -allowProvisioningUpdates \
  -authenticationKeyPath "$work/AuthKey.p8" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
