//! The cryptography of account remote access, as the backend README defines it
//! ("Remote access API" → "Protocol (clients)"). The backend only stores these
//! values; hosts and devices make and check them. Its `tests/remote_protocol.py`
//! is the reference, and the tests below use vectors produced by it.
//!
//! Pure: no I/O, no clock, randomness only where the protocol asks for it.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use hpke::aead::ChaCha20Poly1305 as HpkeChaCha20Poly1305;
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable, Kem as _, OpModeR, OpModeS, Serializable};
use rand::RngCore as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

type HmacSha256 = Hmac<Sha256>;

pub const PAIR_LABEL: &str = "atomic-remote/pair/v1";
pub const CREDENTIAL_LABEL: &str = "atomic-remote/credential/v1";
pub const ENDPOINTS_LABEL: &str = "atomic-remote/endpoints/v1";
pub const SAS_LABEL: &str = "atomic-remote/sas/v1";

/// The deep link a host shows as a QR code.
pub const PAIR_LINK_PREFIX: &str = "atomic-chat://remote/pair";

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
/// An X25519 encapsulated key.
const ENC_BYTES: usize = 32;
/// What the backend accepts for an envelope or a blob, decoded.
pub const MAX_BLOB_BYTES: usize = 3072;
/// Pairing codes: 8 letters of this alphabet, shown as `BCDF-GHJK`.
const CODE_ALPHABET: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";
const CODE_LENGTH: usize = 8;
const MAX_ENDPOINTS: usize = 16;
const MAX_URL_LEN: usize = 512;

/// Why a protocol value was refused. Deliberately coarse: the caller only
/// needs to know that it cannot be trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    /// Not unpadded base64url, or the wrong length.
    Encoding,
    /// Decryption or authentication failed.
    Crypto,
    /// Decrypted, but not the JSON this version expects.
    Payload,
    /// Too large for the backend to store.
    TooLarge,
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            Self::Encoding => "malformed remote-access value",
            Self::Crypto => "remote-access value failed to decrypt or verify",
            Self::Payload => "remote-access payload has an unexpected shape",
            Self::TooLarge => "remote-access value is too large",
        };
        f.write_str(text)
    }
}

impl std::error::Error for ProtocolError {}

pub fn b64u(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Strict unpadded base64url, as the backend checks it.
pub fn unb64u(text: &str) -> Result<Vec<u8>, ProtocolError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(text)
        .map_err(|_| ProtocolError::Encoding)?;
    // The backend refuses non-canonical spellings of the same bytes.
    if URL_SAFE_NO_PAD.encode(&bytes) != text {
        return Err(ProtocolError::Encoding);
    }
    Ok(bytes)
}

fn unb64u_32(text: &str) -> Result<[u8; KEY_BYTES], ProtocolError> {
    unb64u(text)?
        .try_into()
        .map_err(|_| ProtocolError::Encoding)
}

fn random_32() -> [u8; KEY_BYTES] {
    let mut bytes = [0u8; KEY_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
}

fn hmac_b64(secret: &[u8], message: &str) -> String {
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(secret).expect("HMAC takes a key of any length");
    mac.update(message.as_bytes());
    b64u(&mac.finalize().into_bytes())
}

fn hmac_verify(secret: &[u8], message: &str, expected: &str) -> bool {
    let Ok(tag) = unb64u(expected) else {
        return false;
    };
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(secret).expect("HMAC takes a key of any length");
    mac.update(message.as_bytes());
    // Constant time.
    mac.verify_slice(&tag).is_ok()
}

// ---------------------------------------------------------------------------
// The device key

/// This install's X25519 key. The private half never leaves the app; the
/// public half is registered with `PUT /v1/remote/device`.
#[derive(Clone)]
pub struct DeviceKey {
    secret: [u8; KEY_BYTES],
}

impl std::fmt::Debug for DeviceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceKey")
            .field("public", &self.public_b64())
            .finish_non_exhaustive()
    }
}

impl DeviceKey {
    pub fn generate() -> Self {
        Self {
            secret: random_32(),
        }
    }

    pub fn from_secret_b64(text: &str) -> Result<Self, ProtocolError> {
        Ok(Self {
            secret: unb64u_32(text)?,
        })
    }

    pub fn secret_b64(&self) -> String {
        b64u(&self.secret)
    }

    fn private(&self) -> <X25519HkdfSha256 as hpke::Kem>::PrivateKey {
        <X25519HkdfSha256 as hpke::Kem>::PrivateKey::from_bytes(&self.secret)
            .expect("any 32 bytes are an X25519 private key")
    }

    /// Raw 32 bytes as unpadded base64url (43 characters).
    pub fn public_b64(&self) -> String {
        b64u(&X25519HkdfSha256::sk_to_pk(&self.private()).to_bytes())
    }
}

// ---------------------------------------------------------------------------
// Pairing

/// The 8 letters of a typed pairing code, any case, dashes and spaces
/// ignored; `None` when it cannot be a code. Mirrors the backend's
/// `normalize_user_code`.
pub fn normalize_code(raw: &str) -> Option<String> {
    let code: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect::<String>()
        .to_ascii_uppercase();
    let valid = code.len() == CODE_LENGTH && code.bytes().all(|b| CODE_ALPHABET.contains(&b));
    valid.then_some(code)
}

/// `BCDFGHJK` → `BCDF-GHJK`.
pub fn format_code(code: &str) -> String {
    let half = code.len() / 2;
    format!("{}-{}", &code[..half], &code[half..])
}

/// The pairing secret of a typed code: its 8 letters, no dash, upper case.
pub fn code_secret(normalized_code: &str) -> Vec<u8> {
    normalized_code.as_bytes().to_vec()
}

/// 32 random bytes a host shows only inside its QR code.
pub fn new_qr_secret() -> [u8; KEY_BYTES] {
    random_32()
}

/// The QR link for a code: `atomic-chat://remote/pair?c=<code>&k=<qr_secret>`.
pub fn pair_link(formatted_code: &str, qr_secret: &[u8]) -> String {
    format!(
        "{PAIR_LINK_PREFIX}?c={formatted_code}&k={}",
        b64u(qr_secret)
    )
}

/// What a device pairs with: the code it sends to the backend and the secret
/// its proof is made with (the QR secret when it has one, else the letters).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairInput {
    /// Normalized, without the dash.
    pub code: String,
    pub secret: Vec<u8>,
    pub from_link: bool,
}

/// A typed code, or a pasted pair link.
pub fn parse_pair_input(raw: &str) -> Option<PairInput> {
    let raw = raw.trim();
    if raw.len() >= PAIR_LINK_PREFIX.len()
        && raw[..PAIR_LINK_PREFIX.len()].eq_ignore_ascii_case(PAIR_LINK_PREFIX)
    {
        let url = Url::parse(raw).ok()?;
        let mut code = None;
        let mut key = None;
        for (name, value) in url.query_pairs() {
            match name.as_ref() {
                "c" => code = normalize_code(&value),
                "k" => key = unb64u_32(&value).ok(),
                _ => {}
            }
        }
        let code = code?;
        return Some(match key {
            Some(key) => PairInput {
                code,
                secret: key.to_vec(),
                from_link: true,
            },
            // A link without its key still carries the code.
            None => PairInput {
                secret: code_secret(&code),
                code,
                from_link: true,
            },
        });
    }
    let code = normalize_code(raw)?;
    Some(PairInput {
        secret: code_secret(&code),
        code,
        from_link: false,
    })
}

/// `HMAC-SHA256(S, "atomic-remote/pair/v1|" + client_public_key)`.
pub fn pair_proof(secret: &[u8], client_public_key: &str) -> String {
    hmac_b64(secret, &format!("{PAIR_LABEL}|{client_public_key}"))
}

pub fn verify_pair_proof(secret: &[u8], client_public_key: &str, proof: &str) -> bool {
    hmac_verify(secret, &format!("{PAIR_LABEL}|{client_public_key}"), proof)
}

// ---------------------------------------------------------------------------
// The credential envelope

/// What a host hands a device, sealed to the device's key.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Credential {
    pub v: u32,
    pub api_key: String,
    /// 32 random bytes, base64url; keys the endpoints blob.
    pub grant_secret: String,
    pub host_name: String,
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("v", &self.v)
            .field("host_name", &self.host_name)
            .finish_non_exhaustive()
    }
}

impl Credential {
    pub fn grant_secret_bytes(&self) -> Result<[u8; KEY_BYTES], ProtocolError> {
        unb64u_32(&self.grant_secret)
    }
}

fn credential_info(grant_id: &str) -> String {
    format!("{CREDENTIAL_LABEL}|{grant_id}")
}

/// HPKE base mode to the device key; `enc ‖ ciphertext` as base64url.
pub fn seal_credential(
    client_public_key: &str,
    grant_id: &str,
    credential: &Credential,
) -> Result<String, ProtocolError> {
    let public =
        <X25519HkdfSha256 as hpke::Kem>::PublicKey::from_bytes(&unb64u_32(client_public_key)?)
            .map_err(|_| ProtocolError::Encoding)?;
    let plaintext = serde_json::to_vec(credential).map_err(|_| ProtocolError::Payload)?;
    let (enc, ciphertext) =
        hpke::single_shot_seal::<HpkeChaCha20Poly1305, HkdfSha256, X25519HkdfSha256, _>(
            &OpModeS::Base,
            &public,
            credential_info(grant_id).as_bytes(),
            &plaintext,
            &[],
            &mut rand::rngs::OsRng,
        )
        .map_err(|_| ProtocolError::Crypto)?;
    let mut sealed = enc.to_bytes().to_vec();
    sealed.extend_from_slice(&ciphertext);
    if sealed.len() > MAX_BLOB_BYTES {
        return Err(ProtocolError::TooLarge);
    }
    Ok(b64u(&sealed))
}

pub fn open_credential(
    key: &DeviceKey,
    grant_id: &str,
    envelope: &str,
) -> Result<Credential, ProtocolError> {
    let sealed = unb64u(envelope)?;
    if sealed.len() <= ENC_BYTES || sealed.len() > MAX_BLOB_BYTES {
        return Err(ProtocolError::Encoding);
    }
    let (enc, ciphertext) = sealed.split_at(ENC_BYTES);
    let enc = <X25519HkdfSha256 as hpke::Kem>::EncappedKey::from_bytes(enc)
        .map_err(|_| ProtocolError::Encoding)?;
    let plaintext = hpke::single_shot_open::<HpkeChaCha20Poly1305, HkdfSha256, X25519HkdfSha256>(
        &OpModeR::Base,
        &key.private(),
        &enc,
        credential_info(grant_id).as_bytes(),
        ciphertext,
        &[],
    )
    .map_err(|_| ProtocolError::Crypto)?;
    let credential: Credential =
        serde_json::from_slice(&plaintext).map_err(|_| ProtocolError::Payload)?;
    if credential.v != 1 || credential.api_key.trim().is_empty() {
        return Err(ProtocolError::Payload);
    }
    credential
        .grant_secret_bytes()
        .map_err(|_| ProtocolError::Payload)?;
    Ok(credential)
}

/// `HMAC-SHA256(S, "atomic-remote/credential/v1|" + grant_id + "|" + envelope)`.
/// Proves to a device that paired by code that the envelope is the host's:
/// the backend knows the device's public key and could encrypt to it too.
pub fn credential_mac(secret: &[u8], grant_id: &str, envelope: &str) -> String {
    hmac_b64(secret, &format!("{CREDENTIAL_LABEL}|{grant_id}|{envelope}"))
}

pub fn verify_credential_mac(secret: &[u8], grant_id: &str, envelope: &str, mac: &str) -> bool {
    hmac_verify(
        secret,
        &format!("{CREDENTIAL_LABEL}|{grant_id}|{envelope}"),
        mac,
    )
}

// ---------------------------------------------------------------------------
// The endpoints blob

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EndpointKind {
    Tunnel,
    Lan,
}

/// One address of the host's public API, with its `/v1` prefix.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Endpoint {
    pub kind: EndpointKind,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EndpointsPayload {
    pub v: u32,
    pub seq: u64,
    pub endpoints: Vec<Endpoint>,
}

/// The wire form, lenient so a newer host's extra kinds are skipped rather
/// than failing the whole blob.
#[derive(Deserialize)]
struct WireEndpoints {
    v: u32,
    seq: u64,
    endpoints: Vec<WireEndpoint>,
}

#[derive(Deserialize)]
struct WireEndpoint {
    kind: String,
    url: String,
}

fn endpoints_key(grant_secret: &[u8]) -> [u8; KEY_BYTES] {
    let mut key = [0u8; KEY_BYTES];
    Hkdf::<Sha256>::new(None, grant_secret)
        .expand(ENDPOINTS_LABEL.as_bytes(), &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 length");
    key
}

/// An address a client may dial: http(s), a host, no credentials in it.
pub fn is_dialable_url(raw: &str) -> bool {
    if raw.len() > MAX_URL_LEN {
        return false;
    }
    match Url::parse(raw) {
        Ok(url) => {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some_and(|h| !h.is_empty())
                && url.username().is_empty()
                && url.password().is_none()
        }
        Err(_) => false,
    }
}

/// `nonce(12) ‖ ChaCha20-Poly1305(key, nonce, plaintext, aad = grant_id)`.
pub fn seal_endpoints(
    grant_secret: &[u8],
    grant_id: &str,
    seq: u64,
    endpoints: &[Endpoint],
) -> Result<String, ProtocolError> {
    let payload = EndpointsPayload {
        v: 1,
        seq,
        endpoints: endpoints.iter().take(MAX_ENDPOINTS).cloned().collect(),
    };
    let plaintext = serde_json::to_vec(&payload).map_err(|_| ProtocolError::Payload)?;
    let cipher = ChaCha20Poly1305::new((&endpoints_key(grant_secret)).into());
    let mut nonce = [0u8; NONCE_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: grant_id.as_bytes(),
            },
        )
        .map_err(|_| ProtocolError::Crypto)?;
    let mut sealed = nonce.to_vec();
    sealed.extend_from_slice(&ciphertext);
    if sealed.len() > MAX_BLOB_BYTES {
        return Err(ProtocolError::TooLarge);
    }
    Ok(b64u(&sealed))
}

/// Opens a blob and keeps the endpoints this version can dial.
pub fn open_endpoints(
    grant_secret: &[u8],
    grant_id: &str,
    blob: &str,
) -> Result<EndpointsPayload, ProtocolError> {
    let sealed = unb64u(blob)?;
    if sealed.len() <= NONCE_BYTES || sealed.len() > MAX_BLOB_BYTES {
        return Err(ProtocolError::Encoding);
    }
    let (nonce, ciphertext) = sealed.split_at(NONCE_BYTES);
    let cipher = ChaCha20Poly1305::new((&endpoints_key(grant_secret)).into());
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: grant_id.as_bytes(),
            },
        )
        .map_err(|_| ProtocolError::Crypto)?;
    let wire: WireEndpoints =
        serde_json::from_slice(&plaintext).map_err(|_| ProtocolError::Payload)?;
    if wire.v != 1 {
        return Err(ProtocolError::Payload);
    }
    let endpoints = wire
        .endpoints
        .into_iter()
        .filter_map(|e| {
            let kind = match e.kind.as_str() {
                "tunnel" => EndpointKind::Tunnel,
                "lan" => EndpointKind::Lan,
                _ => return None,
            };
            is_dialable_url(&e.url).then_some(Endpoint { kind, url: e.url })
        })
        .take(MAX_ENDPOINTS)
        .collect();
    Ok(EndpointsPayload {
        v: wire.v,
        seq: wire.seq,
        endpoints,
    })
}

// ---------------------------------------------------------------------------
// The check code ("Allow")

/// First 4 bytes of `SHA-256("atomic-remote/sas/v1|" + host_id + "|" +
/// client_device_id + "|" + client_public_key)`, big-endian, mod 10^6.
pub fn sas(host_id: &str, client_device_id: &str, client_public_key: &str) -> String {
    let digest = Sha256::digest(
        format!("{SAS_LABEL}|{host_id}|{client_device_id}|{client_public_key}").as_bytes(),
    );
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{value:06}")
}

/// A new key for a device's access to this host's public API.
pub fn new_device_api_key() -> String {
    format!("sk-atomic-{}", b64u(&random_32()))
}

/// A new `grant_secret`, as the credential carries it.
pub fn new_grant_secret() -> String {
    b64u(&random_32())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Produced by atomic-chat-backend `tests/remote_protocol.py` (2026-11-12):
    // device secret = bytes 1..=32, qr secret = bytes 100..=131, grant secret =
    // bytes 200..=231.
    const DEVICE_SECRET: &str = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
    const DEVICE_PUBLIC: &str = "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw";
    const GRANT_ID: &str = "6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
    const HOST_ID: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const CLIENT_DEVICE_ID: &str = "11111111-2222-4333-8444-555555555555";
    const CODE: &str = "BCDF-GHJK";
    const CODE_PROOF: &str = "f0KsN1PXKVZmYj-zk_SoZbLrdomMpCMjdYpcbFPqu58";
    const QR_SECRET: &str = "ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4CBgoM";
    const QR_PROOF: &str = "4Nb-6qlYKuKMhF7L_C55WD2hzM0_-swcTzvL0Yaf8AU";
    const ENVELOPE: &str = "Rni3WWzYOmGfKSZRDhlpL-lYD7j7o92Eu6jhF7mEEA1Na-eF6UhCl9d8XhJnFfPEtrLj-4qN6p7mdRiS2DBk4RCGwykVCxhognvxY1p0aReHpAfpwaNxYAYho87_XXt0WV8dL2Ij_9VB3-tuuDU18ZkfLuz3Eiw3RYGrkgeBACmAmIvw26elTOO9ZKXzfK5fCp83UdfjNc5EUGDMH2rloiG5BZSQZMxPfo14qBtsRn9D-6Q";
    const CODE_MAC: &str = "ez1CtfWZ9mhme0ubEXcFldK4E3j30b0IDYk3A7_LMmI";
    const QR_MAC: &str = "qs83HPxlQv_ynJjYg0ublOFwYWcQAq2-dJM450I5kYE";
    const GRANT_SECRET: &str = "yMnKy8zNzs_Q0dLT1NXW19jZ2tvc3d7f4OHi4-Tl5uc";
    const ENDPOINTS_KEY: &str = "daUPG-dulL_L_fdJ_H5zmxRckkR78mxLhstfUgcb5E0";
    const BLOB: &str = "956G7mQb8mp4lbCnqJTFwU1n3bqXWNRpaMtRMvrida5ZdqJVh-DgjTZSMJITpcTNLV3fhbAFGHu8LRtERd8beVX0i6C_LNunSO5SnEdVl3mP2AUh73-q6fhKlw_wd-dU-pspw1C25Fe_tfEcTBINDAB_ShC0GWa6359tyU4hwni6xjx7OIan54R2e2qOUoZPmyednsi2vE6MTnLVPXZ7kj_MFP2gzADlNWmGbm_MOLIfyMnWD2lK4f8";
    const SAS: &str = "936468";

    fn device() -> DeviceKey {
        DeviceKey::from_secret_b64(DEVICE_SECRET).unwrap()
    }

    fn grant_secret() -> Vec<u8> {
        unb64u(GRANT_SECRET).unwrap()
    }

    #[test]
    fn derives_the_reference_public_key() {
        assert_eq!(device().public_b64(), DEVICE_PUBLIC);
        assert_eq!(device().secret_b64(), DEVICE_SECRET);
    }

    #[test]
    fn debug_output_hides_the_private_key() {
        let shown = format!("{:?}", device());
        assert!(!shown.contains(DEVICE_SECRET));
        assert!(shown.contains(DEVICE_PUBLIC));
    }

    #[test]
    fn makes_the_reference_proofs() {
        let code = normalize_code(CODE).unwrap();
        assert_eq!(pair_proof(&code_secret(&code), DEVICE_PUBLIC), CODE_PROOF);
        let qr = unb64u(QR_SECRET).unwrap();
        assert_eq!(pair_proof(&qr, DEVICE_PUBLIC), QR_PROOF);
        assert!(verify_pair_proof(&qr, DEVICE_PUBLIC, QR_PROOF));
        assert!(!verify_pair_proof(&qr, DEVICE_PUBLIC, CODE_PROOF));
        assert!(!verify_pair_proof(&qr, DEVICE_PUBLIC, "not base64!"));
    }

    #[test]
    fn opens_a_reference_envelope_and_checks_its_macs() {
        let credential = open_credential(&device(), GRANT_ID, ENVELOPE).unwrap();
        assert_eq!(credential.v, 1);
        assert_eq!(credential.api_key, "sk-atomic-test-key");
        assert_eq!(credential.grant_secret, GRANT_SECRET);
        assert_eq!(credential.host_name, "Studio Mac");

        let code = code_secret(&normalize_code(CODE).unwrap());
        let qr = unb64u(QR_SECRET).unwrap();
        assert_eq!(credential_mac(&code, GRANT_ID, ENVELOPE), CODE_MAC);
        assert_eq!(credential_mac(&qr, GRANT_ID, ENVELOPE), QR_MAC);
        assert!(verify_credential_mac(&code, GRANT_ID, ENVELOPE, CODE_MAC));
        assert!(!verify_credential_mac(&code, GRANT_ID, ENVELOPE, QR_MAC));
    }

    #[test]
    fn refuses_an_envelope_for_another_grant_or_key() {
        let other_grant = "6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5c";
        assert_eq!(
            open_credential(&device(), other_grant, ENVELOPE),
            Err(ProtocolError::Crypto)
        );
        assert_eq!(
            open_credential(&DeviceKey::generate(), GRANT_ID, ENVELOPE),
            Err(ProtocolError::Crypto)
        );
        assert_eq!(
            open_credential(&device(), GRANT_ID, "AAAA"),
            Err(ProtocolError::Encoding)
        );
    }

    #[test]
    fn seals_a_credential_the_device_can_open() {
        let key = DeviceKey::generate();
        let credential = Credential {
            v: 1,
            api_key: new_device_api_key(),
            grant_secret: new_grant_secret(),
            host_name: "Ann's MacBook".to_string(),
        };
        let envelope = seal_credential(&key.public_b64(), GRANT_ID, &credential).unwrap();
        assert_eq!(
            open_credential(&key, GRANT_ID, &envelope).unwrap(),
            credential
        );
        // Every seal is fresh.
        assert_ne!(
            envelope,
            seal_credential(&key.public_b64(), GRANT_ID, &credential).unwrap()
        );
    }

    #[test]
    fn derives_the_reference_endpoints_key_and_opens_its_blob() {
        assert_eq!(b64u(&endpoints_key(&grant_secret())), ENDPOINTS_KEY);
        let payload = open_endpoints(&grant_secret(), GRANT_ID, BLOB).unwrap();
        assert_eq!(payload.seq, 3);
        assert_eq!(
            payload.endpoints,
            vec![
                Endpoint {
                    kind: EndpointKind::Tunnel,
                    url: "https://words-here.trycloudflare.com/v1".to_string(),
                },
                Endpoint {
                    kind: EndpointKind::Lan,
                    url: "http://192.168.1.5:1337/v1".to_string(),
                },
            ]
        );
        assert_eq!(
            open_endpoints(&grant_secret(), "another-grant", BLOB),
            Err(ProtocolError::Crypto)
        );
    }

    #[test]
    fn seals_endpoints_and_skips_what_cannot_be_dialled() {
        let secret = grant_secret();
        let endpoints = vec![
            Endpoint {
                kind: EndpointKind::Tunnel,
                url: "https://a.trycloudflare.com/v1".to_string(),
            },
            Endpoint {
                kind: EndpointKind::Lan,
                url: "file:///etc/passwd".to_string(),
            },
        ];
        let blob = seal_endpoints(&secret, GRANT_ID, 7, &endpoints).unwrap();
        let opened = open_endpoints(&secret, GRANT_ID, &blob).unwrap();
        assert_eq!(opened.seq, 7);
        assert_eq!(opened.endpoints, endpoints[..1].to_vec());
    }

    #[test]
    fn makes_the_reference_check_code() {
        assert_eq!(sas(HOST_ID, CLIENT_DEVICE_ID, DEVICE_PUBLIC), SAS);
    }

    #[test]
    fn normalizes_codes_like_the_backend() {
        assert_eq!(normalize_code(" bcdf-ghjk ").as_deref(), Some("BCDFGHJK"));
        assert_eq!(normalize_code("BCDF GHJK").as_deref(), Some("BCDFGHJK"));
        // Vowels and digits are not in the alphabet.
        assert_eq!(normalize_code("ABCD-EFGH"), None);
        assert_eq!(normalize_code("BCDF-GHJ"), None);
        assert_eq!(format_code("BCDFGHJK"), "BCDF-GHJK");
    }

    #[test]
    fn parses_typed_codes_and_pair_links() {
        let typed = parse_pair_input("bcdf-ghjk").unwrap();
        assert_eq!(typed.code, "BCDFGHJK");
        assert_eq!(typed.secret, b"BCDFGHJK".to_vec());
        assert!(!typed.from_link);

        let qr = unb64u(QR_SECRET).unwrap();
        let link = pair_link(CODE, &qr);
        assert_eq!(
            link,
            format!("atomic-chat://remote/pair?c=BCDF-GHJK&k={QR_SECRET}")
        );
        let linked = parse_pair_input(&link).unwrap();
        assert_eq!(linked.code, "BCDFGHJK");
        assert_eq!(linked.secret, qr);
        assert!(linked.from_link);

        let keyless = parse_pair_input("atomic-chat://remote/pair?c=BCDF-GHJK").unwrap();
        assert_eq!(keyless.secret, b"BCDFGHJK".to_vec());

        assert!(parse_pair_input("atomic-chat://remote/pair?k=abc").is_none());
        assert!(parse_pair_input("hello").is_none());
    }

    #[test]
    fn refuses_non_canonical_base64() {
        assert!(unb64u("AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=").is_err());
        assert!(unb64u("AQ+/").is_err());
        assert!(DeviceKey::from_secret_b64("AQID").is_err());
    }

    #[test]
    fn device_api_keys_fit_the_core_key_rules() {
        let key = new_device_api_key();
        assert!(key.starts_with("sk-atomic-"));
        assert!((20..=256).contains(&key.len()));
        assert!(key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-')));
    }

    #[test]
    fn only_http_urls_with_a_host_are_dialable() {
        assert!(is_dialable_url("https://x.trycloudflare.com/v1"));
        assert!(is_dialable_url("http://10.0.0.2:1337/v1"));
        assert!(!is_dialable_url("javascript:alert(1)"));
        assert!(!is_dialable_url("https://user:pw@x.example/v1"));
        assert!(!is_dialable_url(&format!(
            "https://x.example/{}",
            "a".repeat(600)
        )));
    }
}
