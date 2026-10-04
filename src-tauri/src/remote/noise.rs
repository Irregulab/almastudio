//! The encrypted channel between the desktop and a companion device.
//!
//! Every connection, on the local network or through the relay, runs the
//! Noise IK handshake: the phone already knows the desktop's static key from
//! the pairing QR code, and the desktop learns the phone's from the first
//! message and checks it against the paired devices. After that every frame is
//! sealed with ChaCha20-Poly1305, so plain `ws://` on the LAN is as safe as TLS
//! and the relay only ever forwards ciphertext.
//!
//! A Noise message holds at most 64 KiB, and a scrollback snapshot is bigger,
//! so plaintext is split into chunks that each carry a one-byte flag: `1` when
//! more chunks of the same message follow, `0` on the last.

use snow::{HandshakeState, TransportState};

pub const PARAMS: &str = "Noise_IK_25519_ChaChaPoly_SHA256";
/// Bound into the handshake, so a peer speaking another protocol (or a later,
/// incompatible version of this one) fails the handshake instead of
/// misreading frames.
pub const PROLOGUE: &[u8] = b"almastudio-remote-v1";

const MAX_NOISE_MSG: usize = 65535;
const TAG_LEN: usize = 16;
/// Plaintext per chunk, leaving room for the flag byte and the AEAD tag.
const CHUNK: usize = MAX_NOISE_MSG - TAG_LEN - 1;
/// A message reassembled from chunks may not exceed this.
const MAX_MESSAGE: usize = 32 * 1024 * 1024;

pub fn generate_keypair() -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
    let kp = snow::Builder::new(PARAMS.parse()?).generate_keypair()?;
    Ok((kp.private, kp.public))
}

/// The desktop's side of the handshake.
pub fn responder(private_key: &[u8]) -> anyhow::Result<HandshakeState> {
    Ok(snow::Builder::new(PARAMS.parse()?)
        .local_private_key(private_key)?
        .prologue(PROLOGUE)?
        .build_responder()?)
}

/// The phone's side; used by tests here, and by the relay's own tests.
#[cfg(test)]
pub fn initiator(private_key: &[u8], remote_public: &[u8]) -> anyhow::Result<HandshakeState> {
    Ok(snow::Builder::new(PARAMS.parse()?)
        .local_private_key(private_key)?
        .remote_public_key(remote_public)?
        .prologue(PROLOGUE)?
        .build_initiator()?)
}

/// Reads one handshake message, returning its payload.
pub fn read_handshake(hs: &mut HandshakeState, msg: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut buf = vec![0u8; MAX_NOISE_MSG];
    let n = hs.read_message(msg, &mut buf)?;
    buf.truncate(n);
    Ok(buf)
}

/// Writes one handshake message carrying `payload`.
pub fn write_handshake(hs: &mut HandshakeState, payload: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut buf = vec![0u8; MAX_NOISE_MSG];
    let n = hs.write_message(payload, &mut buf)?;
    buf.truncate(n);
    Ok(buf)
}

/// A finished handshake: seals outgoing messages and opens incoming ones.
pub struct Channel {
    ts: TransportState,
    partial: Vec<u8>,
}

impl Channel {
    pub fn new(hs: HandshakeState) -> anyhow::Result<Self> {
        Ok(Self { ts: hs.into_transport_mode()?, partial: Vec::new() })
    }

    /// Encrypts `plain` into one or more frames, in the order they must be sent.
    pub fn seal(&mut self, plain: &[u8]) -> anyhow::Result<Vec<Vec<u8>>> {
        let mut frames = Vec::with_capacity(plain.len() / CHUNK + 1);
        let mut chunks = plain.chunks(CHUNK).peekable();
        // An empty message is still one (empty, final) chunk.
        if chunks.peek().is_none() {
            frames.push(self.seal_chunk(&[], false)?);
        }
        while let Some(chunk) = chunks.next() {
            let more = chunks.peek().is_some();
            frames.push(self.seal_chunk(chunk, more)?);
        }
        Ok(frames)
    }

    fn seal_chunk(&mut self, chunk: &[u8], more: bool) -> anyhow::Result<Vec<u8>> {
        let mut plain = Vec::with_capacity(chunk.len() + 1);
        plain.push(u8::from(more));
        plain.extend_from_slice(chunk);
        let mut out = vec![0u8; plain.len() + TAG_LEN];
        let n = self.ts.write_message(&plain, &mut out)?;
        out.truncate(n);
        Ok(out)
    }

    /// Decrypts one frame. Returns the whole message once its last chunk is in.
    pub fn open(&mut self, frame: &[u8]) -> anyhow::Result<Option<Vec<u8>>> {
        let mut plain = vec![0u8; frame.len()];
        let n = self.ts.read_message(frame, &mut plain)?;
        plain.truncate(n);
        let Some((&flag, body)) = plain.split_first() else {
            anyhow::bail!("empty frame");
        };
        if self.partial.len() + body.len() > MAX_MESSAGE {
            anyhow::bail!("message too large");
        }
        self.partial.extend_from_slice(body);
        if flag == 1 {
            return Ok(None);
        }
        Ok(Some(std::mem::take(&mut self.partial)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (Channel, Channel, Vec<u8>) {
        let (desk_priv, desk_pub) = generate_keypair().unwrap();
        let (phone_priv, phone_pub) = generate_keypair().unwrap();
        let mut ini = initiator(&phone_priv, &desk_pub).unwrap();
        let mut resp = responder(&desk_priv).unwrap();

        let m1 = write_handshake(&mut ini, b"hello").unwrap();
        assert_eq!(read_handshake(&mut resp, &m1).unwrap(), b"hello");
        // The desktop learns who is calling from the first message.
        let seen = resp.get_remote_static().unwrap().to_vec();
        assert_eq!(seen, phone_pub);

        let m2 = write_handshake(&mut resp, b"ok").unwrap();
        assert_eq!(read_handshake(&mut ini, &m2).unwrap(), b"ok");
        (Channel::new(ini).unwrap(), Channel::new(resp).unwrap(), seen)
    }

    #[test]
    fn round_trips_small_and_empty_messages() {
        let (mut phone, mut desk, _) = pair();
        for msg in [&b"{}"[..], &b""[..]] {
            let frames = phone.seal(msg).unwrap();
            assert_eq!(frames.len(), 1);
            assert_eq!(desk.open(&frames[0]).unwrap().unwrap(), msg);
        }
    }

    #[test]
    fn splits_and_reassembles_large_messages() {
        let (mut phone, mut desk, _) = pair();
        let big: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let frames = desk.seal(&big).unwrap();
        assert!(frames.len() > 1);
        assert!(frames.iter().all(|f| f.len() <= MAX_NOISE_MSG));
        let mut out = None;
        for f in &frames {
            out = phone.open(f).unwrap();
        }
        assert_eq!(out.unwrap(), big);
    }

    #[test]
    fn rejects_a_tampered_frame() {
        let (mut phone, mut desk, _) = pair();
        let mut frames = phone.seal(b"secret").unwrap();
        frames[0][3] ^= 0xff;
        assert!(desk.open(&frames[0]).is_err());
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Fixed-key vectors the app's TypeScript implementation is tested
    /// against (packages/protocol/src/noise.test.ts), so the two sides of the
    /// handshake cannot drift apart. Run with ALMASTUDIO_WRITE_VECTORS=1 to
    /// rewrite the file after a deliberate change.
    #[test]
    fn matches_the_vectors_the_app_is_tested_against() {
        let desk_priv = [1u8; 32];
        let phone_priv = [2u8; 32];
        let phone_eph = [3u8; 32];
        let desk_eph = [4u8; 32];
        let params: snow::params::NoiseParams = PARAMS.parse().unwrap();
        let mut ini = snow::Builder::new(params.clone())
            .local_private_key(&phone_priv)
            .unwrap()
            .remote_public_key(&x25519_public(&desk_priv))
            .unwrap()
            .prologue(PROLOGUE)
            .unwrap()
            .fixed_ephemeral_key_for_testing_only(&phone_eph)
            .build_initiator()
            .unwrap();
        let mut resp = snow::Builder::new(params)
            .local_private_key(&desk_priv)
            .unwrap()
            .prologue(PROLOGUE)
            .unwrap()
            .fixed_ephemeral_key_for_testing_only(&desk_eph)
            .build_responder()
            .unwrap();

        let m1 = write_handshake(&mut ini, b"{\"name\":\"test\"}").unwrap();
        read_handshake(&mut resp, &m1).unwrap();
        let m2 = write_handshake(&mut resp, b"{\"ok\":true}").unwrap();
        read_handshake(&mut ini, &m2).unwrap();
        let mut phone = Channel::new(ini).unwrap();
        let mut desk = Channel::new(resp).unwrap();
        let up = phone.seal(b"ping").unwrap();
        let down = desk.seal(b"pong").unwrap();
        assert_eq!(desk.open(&up[0]).unwrap().unwrap(), b"ping");

        let vectors = serde_json::json!({
            "deskPrivate": hex(&desk_priv),
            "phonePrivate": hex(&phone_priv),
            "phoneEphemeral": hex(&phone_eph),
            "msg1": hex(&m1),
            "msg2": hex(&m2),
            "up": hex(&up[0]),
            "down": hex(&down[0]),
        });
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../packages/protocol/src/noise-vectors.json");
        let text = serde_json::to_string_pretty(&vectors).unwrap() + "\n";
        if std::env::var_os("ALMASTUDIO_WRITE_VECTORS").is_some() {
            std::fs::write(&path, &text).unwrap();
        }
        let saved = std::fs::read_to_string(&path).expect("run with ALMASTUDIO_WRITE_VECTORS=1");
        assert_eq!(saved, text);
    }

    /// The public half of a fixed private key, from snow's own X25519.
    fn x25519_public(private: &[u8; 32]) -> Vec<u8> {
        let params: snow::params::NoiseParams = "Noise_N_25519_ChaChaPoly_SHA256".parse().unwrap();
        let resolver = snow::resolvers::DefaultResolver;
        use snow::resolvers::CryptoResolver;
        let mut dh = resolver.resolve_dh(&params.dh).unwrap();
        dh.set(private);
        dh.pubkey().to_vec()
    }

    #[test]
    fn a_wrong_desktop_key_fails_the_handshake() {
        let (_, desk_pub) = generate_keypair().unwrap();
        let (other_priv, _) = generate_keypair().unwrap();
        let (phone_priv, _) = generate_keypair().unwrap();
        // The phone thinks it is talking to `desk_pub`, but `other` answers.
        let mut ini = initiator(&phone_priv, &desk_pub).unwrap();
        let mut resp = responder(&other_priv).unwrap();
        let m1 = write_handshake(&mut ini, b"").unwrap();
        assert!(read_handshake(&mut resp, &m1).is_err());
    }
}
