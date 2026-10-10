# macOS Release

Production distribution outside the Mac App Store requires an active Apple Developer membership and the certificate **Developer ID Application: Ally Rippley (YM4H8YJWGU)** with its private key in an unlocked macOS keychain. Team ID: `YM4H8YJWGU`. Xcode, the repository's pinned Rust toolchain, Node satisfying `package.json`, and `npm ci` are required. Install both targets from this repository:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

When macOS requests access to the signing private key, complete the Keychain prompt locally. Do not put your login/keychain password into release scripts or chat.

## Credentials

The installed Tauri 2.12 CLI supports App Store Connect API authentication. In App Store Connect → Users and Access → Integrations → App Store Connect API, create a **Team API key** with Developer access (Account Holder approval may be required). Download its `.p8` once and store it outside all repositories. Export these variables in the release terminal; values below are explanatory placeholders:

```sh
export APPLE_API_ISSUER='<issuer UUID from App Store Connect>'
export APPLE_API_KEY='<key ID, not the private key contents>'
export APPLE_API_KEY_PATH="$HOME/.config/apple-notary/AuthKey_KEYID.p8"
chmod 600 "$APPLE_API_KEY_PATH"
export APPLE_SIGNING_IDENTITY='Developer ID Application: Ally Rippley (YM4H8YJWGU)'
export APPLE_TEAM_ID='YM4H8YJWGU'
```

Alternatively, unset all three API variables and supply `APPLE_ID` and `APPLE_PASSWORD` (an app-specific password created at account.apple.com). Never use the normal Apple account password. Partial API configuration fails rather than falling back. The identity and team default to the public values above. No credential files are loaded automatically; do not put private keys, certificate exports, or passwords in the repository. Keychain signing identities are supported; `APPLE_NOTARY_PROFILE` is not used by this workflow.

## Commands

```sh
npm run release:mac:check                          # preflight only; contacts Apple to validate credentials
npm run release:desktop                           # ARM64, Intel and true universal
npm run release:desktop -- --arch arm64            # one architecture
npm run release:desktop -- --arch x86_64
npm run release:desktop -- --arch universal
npm run release:mac:sign -- --arch arm64           # signed candidate; does NOT claim notarization
npm run test:macos-release
```

`--check` does not compile, archive or alter artifacts; it writes a diagnostic log. It checks tools, versions, Rust targets, the exact certificate identity, brand metadata where applicable, and Apple authentication. The signing-only command is useful before notarization credentials are available. It produces explicitly labeled candidates and never updates production `current`. Compilation still requires network access when dependencies or Apple's secure timestamp service are needed.

The release-only Tauri configuration merges with the application's existing config, preserving its bundle identifier, minimum macOS version, resources and entitlements. It requires Developer ID signing and Hardened Runtime. Tauri signs the app with a secure timestamp, notarizes and staples the app using the supplied credentials, then creates the DMG. The helper independently verifies the app; it submits the final DMG with `notarytool`, requires an `Accepted` response, staples it and verifies Gatekeeper. It mounts the DMG read-only and checks the embedded app against the verified loose app. `lipo` checks real architecture slices. No extra entitlements are added: these apps are distributed outside the App Sandbox, so ordinary filesystem/network/process access does not require sandbox exceptions.

## Outputs and preservation

- `macos-releases/current/<architecture>/`: only fully signed, notarized and verified `.app` and `.dmg` files; `manifest.json` records verification and SHA-256 inventories.
- `macos-releases/archive/<timestamp-id>/`: previous distributables with verified copies, source paths and checksums.
- `macos-releases/candidates/<timestamp-id>/`: signing-only builds; **not approved for distribution**.
- `macos-releases/staging/<timestamp-id>/`: partial builds retained on failure; never promoted.
- `macos-releases/logs/`: full logs with credential values redacted; console output reports phases and failures.

Before building, the helper discovers existing artifacts in legacy `builds/current`, `releases/current`, its own `current`, and Cargo's native/target-specific debug/release bundle directories. It also preserves desktop executable outputs. It archives only distributables and manifests, never entire `target`, `node_modules` or compiler caches. Archive checks compare contents, permissions and symlinks before any bundle directory is removed. New builds are not included in their own history. Compiler caches are reused to limit disk usage. Do not run another native build or legacy release command concurrently in the same checkout.

A lock prevents simultaneous runs of this release helper. Interrupted promotion retains the previous release using a journal. After confirming a crashed process has stopped, run `node scripts/macos-release.mjs --recover`; it refuses recovery if the owner is still alive. Never delete a live lock. Failed builds keep the previous production `current`. Nothing is uploaded or published by the local command.

Existing Windows, Linux and development commands remain available. Their legacy/ad-hoc macOS outputs are not production notarized releases. This command is macOS-only.

## Manual verification

Substitute paths from `macos-releases/current`:

```sh
codesign --verify --deep --strict --verbose=2 'App.app'
codesign -d --verbose=4 'App.app'       # Authority, TeamIdentifier, runtime, Timestamp
lipo -archs 'App.app/Contents/MacOS/<executable>'
xcrun stapler validate 'App.app'
spctl --assess --type execute --verbose=4 'App.app'
codesign --verify --strict --verbose=2 'App.dmg'
xcrun stapler validate 'App.dmg'
spctl --assess --type open --context context:primary-signature --verbose=4 'App.dmg'
```

## CI

The manually dispatched **Production macOS release** workflow uses a macOS runner and the repository's Rust toolchain. Add repository Actions secrets `APPLE_CERTIFICATE` (base64 Developer ID `.p12` export including private key), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_PRIVATE_KEY` (the `.p8` contents), `APPLE_API_ISSUER` and `APPLE_API_KEY`. Certificate/API key files live only in runner temporary storage; the workflow imports into a temporary keychain and removes credentials in its cleanup step. Do not enable shell tracing. Successful artifacts are uploaded as a tar archive to preserve app executable permissions and symlinks. This workflow does not publish a GitHub release. Existing Windows/Linux CI is unchanged.

References: [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) and [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
