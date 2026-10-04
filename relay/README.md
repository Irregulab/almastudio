# AlmaStudio relay

Lets the companion app reach an AlmaStudio desktop that is not on its network.
It only ever forwards ciphertext: the app and the desktop run a Noise handshake
end to end through it (see `src-tauri/src/remote/noise.rs`).

- `GET /v1/desktop/{room}` — a desktop's control socket. The room is
  `base64url(sha256("almastudio-room-v1" ‖ desktop public key))[..32]`, and the
  desktop proves it holds the matching private key with an X25519 challenge
  before it gets the room.
- `GET /v1/client/{room}` — an app connecting. The relay tells the desktop,
  which opens `GET /v1/accept/{room}/{id}?token=…`; the two sockets are then
  piped frame by frame.
- `GET /healthz`.

Nothing is stored. Run it behind a TLS-terminating proxy that passes WebSocket
upgrades; the app and the desktop connect to `wss://relay.almastudio.almaware.net`.

```sh
cargo test
docker build -t almastudio-relay .
docker run -p 8080:8080 almastudio-relay
```
