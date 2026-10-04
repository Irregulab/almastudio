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
With the app closed, the computer sends them through Expo's push service,
which needs the app built with an EAS project:

```sh
npx eas-cli@latest init        # writes extra.eas.projectId to the app config
npx eas-cli@latest credentials # APNs key and FCM credentials
```

## Ship to TestFlight and Play internal testing

```sh
npx eas-cli@latest build --platform ios --profile production --local
npx eas-cli@latest submit --platform ios --path <the .ipa>
npx eas-cli@latest build --platform android --profile production --local
npx eas-cli@latest submit --platform android --path <the .aab>
```

`--local` builds on this Mac, as the desktop releases are. Set
`submit.production.ios.ascAppId` in `eas.json` once the app exists in App
Store Connect.
