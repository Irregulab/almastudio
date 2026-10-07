# AlmaStudio companion

An iPhone, iPad and Android app that drives AlmaStudio on a computer. Nothing
runs on the phone: it shows the computer's terminals, types into them, opens
and restarts agent tabs, and browses files, git and search — all of it on the
computer.

## How it connects

- **Pairing.** On the computer, Settings → Companion app → *Pair a device…*
  shows a QR code holding the computer's public key, its LAN addresses and a
  one-time code valid for five minutes. The app scans it (or opens it as an
  `almastudio://pair?d=…` link), and the computer asks whether to allow the
  device.
- **Encryption.** Every connection runs `Noise_IK_25519_ChaChaPoly_SHA256`
  end to end: `snow` on the computer, `packages/protocol/src/noise.ts` here,
  checked against each other with shared test vectors. Plain `ws://` on the
  LAN is therefore safe, and the relay only forwards ciphertext.
- **Routes.** The app tries the computer's LAN addresses and, when the
  computer has *Reachable from anywhere* on, the relay at the same time, and
  keeps whichever answers first.
- **Terminal size.** While the app shows a terminal it is sized for the
  phone; the computer takes its own size back the moment it is used there,
  or when the app leaves the tab, goes to the background or disconnects.

## Develop

```sh
npm install
npm run typecheck
npx expo run:ios        # or run:android — a development build, not Expo Go
```

The terminal page is built from `packages/terminal-web` with the desktop's
xterm.js: run `npm run build:terminal` (from here or the repository root)
after changing it; the result is committed as `src/terminal/terminalHtml.ts`.

To pair a simulator with a development build of the desktop, start the desktop
with `ALMASTUDIO_REMOTE_DEV_TOKEN=<anything>`: debug builds then accept that
code without asking, and a pairing link can be opened in the simulator with
`xcrun simctl openurl booted 'almastudio://pair?d=…'`, its `d` being base64url
JSON `{"v":1,"n":"Mac","k":"<desktop key>","a":["127.0.0.1:47821"],"t":"<token>","r":null}`.
The desktop key is in `state/remote/identity.json`.

## Notifications

While connected, the computer tells the app directly when an agent finishes
or waits, and the app shows a banner for tabs other than the one on screen.
With the app closed, the computer sends them through Expo's push service
straight to the token the app registered. Expo then needs the store
credentials of each platform:

- **iOS** — an APNs key, created by EAS during the first iOS build (answer yes
  when it offers a push key) or later with `eas credentials -p ios`.
- **Android** — a Firebase project with an Android app for
  `com.irregulab.almastudio.app`. Its `google-services.json` goes to EAS
  as a file variable, which `app.config.js` hands to the build; a copy next to
  `app.config.js` serves local builds and is ignored by git:

  ```sh
  eas env:create --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json \
    --visibility secret --environment development --environment preview --environment production
  ```

  Its service account key (Firebase → Project settings → Service accounts →
  Generate new private key) goes to `eas credentials -p android` → Google
  Service Account → *Push Notifications (FCM V1)*.

Leave *enhanced push security* off in the Expo project: the computer sends
without an access token, since a token shipped with the desktop app would not
stay secret.

## Build and ship with EAS

The app is the EAS project `@irregulab/almastudio-companion`; its id is in
`app.json`. Builds run on expo.dev from this directory — EAS uploads the
whole repository, so `../packages` comes along.

The version and the build number live in `app.json` (`appVersionSource:
local`) and are set before every build: `version` is what the stores show,
and one build number goes to both iOS `buildNumber` and Android
`versionCode`, higher each time, since neither store takes a number twice.
Release builds come from the same private pipeline as the desktop, which asks
for both, commits `app.json` and starts the build; the commands below do the
same by hand once `app.json` is set.

| Profile | What it makes |
| --- | --- |
| `development` | development client for registered devices (`eas device:create`) |
| `development-simulator` | development client for the iOS simulator |
| `preview` | standalone internal build: ad hoc for iOS, an APK for Android |
| `production` | store build for TestFlight and Play |

```sh
npm install -g eas-cli                       # once; then `eas login`
eas build -p ios --profile production        # first run: Apple sign-in, certificate, profile, push key
eas submit -p ios --latest                   # to App Store Connect, then TestFlight
eas build -p android --profile production
eas submit -p android --latest               # to the internal testing track
```

The first iOS build and submit are interactive: EAS signs in to the Apple
developer account (team `TH963HHSMC`), creates the certificate and profiles,
and `submit` creates the app in App Store Connect if it is missing. Play does
not accept an app's first upload through its API: upload the first `.aab`
from the Play Console by hand, then give `eas submit` a Google service account
with access to the app. `--local` builds the same profile on this Mac
instead, with no build minutes spent.
