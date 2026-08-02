use std::{path::Path, sync::Arc, time::Duration};

use rand::rngs::OsRng;
use russh::server::Config;
use ssh_key::private::{Ed25519Keypair, Ed25519PrivateKey, KeypairData};

/// Build the russh server config for the embedded SSH server.
///
/// The Ed25519 host key is persisted at `host_key_path` so the fingerprint
/// stays stable across restarts (a fresh key every boot would trip "host key
/// changed" warnings on clients). Falls back to generating a new key and
/// writing it to disk when the file is missing or unreadable.
pub fn build_config(host_key_path: &Path) -> Arc<Config> {
    let keypair_data = load_or_create_host_key(host_key_path);
    let host_key = russh_keys::PrivateKey::new(keypair_data, "").expect("valid Ed25519 key");

    Arc::new(Config {
        keys: vec![host_key],
        auth_rejection_time: Duration::from_secs(1),
        auth_rejection_time_initial: Some(Duration::from_secs(0)),
        inactivity_timeout: Some(Duration::from_secs(600)),
        keepalive_interval: Some(Duration::from_secs(30)),
        methods: russh::MethodSet::PUBLICKEY,
        ..Default::default()
    })
}

/// Load the persisted Ed25519 keypair, or generate + persist a new one.
fn load_or_create_host_key(host_key_path: &Path) -> KeypairData {
    if let Some(keypair) = load_host_key(host_key_path) {
        return KeypairData::Ed25519(keypair);
    }

    let mut csprng = OsRng;
    let private = Ed25519PrivateKey::random(&mut csprng);
    let keypair = Ed25519Keypair::from(private);

    match persist_host_key(host_key_path, &keypair) {
        Ok(()) => tracing::info!("Generated new SSH host key at {}", host_key_path.display()),
        Err(error) => {
            // A per-boot key is better than failing to boot the SSH server.
            tracing::warn!(
                ?error,
                "Failed to persist SSH host key at {}; using a fresh key for this run",
                host_key_path.display()
            );
        }
    }

    KeypairData::Ed25519(keypair)
}

fn load_host_key(host_key_path: &Path) -> Option<Ed25519Keypair> {
    let bytes = std::fs::read(host_key_path).ok()?;
    let bytes: [u8; Ed25519Keypair::BYTE_SIZE] = bytes.try_into().ok()?;
    match Ed25519Keypair::from_bytes(&bytes) {
        Ok(keypair) => {
            tracing::info!("Loaded SSH host key from {}", host_key_path.display());
            Some(keypair)
        }
        Err(error) => {
            tracing::warn!(
                ?error,
                "Unreadable SSH host key at {}; will regenerate",
                host_key_path.display()
            );
            None
        }
    }
}

fn persist_host_key(host_key_path: &Path, keypair: &Ed25519Keypair) -> std::io::Result<()> {
    if let Some(parent) = host_key_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(host_key_path, keypair.to_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_key_roundtrip_is_stable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key_path = dir.path().join("ssh_host_ed25519_key");

        let first = load_or_create_host_key(&key_path);
        assert!(
            key_path.exists(),
            "host key should be persisted after first generation"
        );

        let second = load_or_create_host_key(&key_path);
        assert_eq!(
            first, second,
            "host key must be identical across restarts when persisted"
        );
    }

    #[test]
    fn corrupted_host_key_is_regenerated() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key_path = dir.path().join("ssh_host_ed25519_key");
        std::fs::write(&key_path, b"not a valid key").expect("write garbage");

        let keypair = load_or_create_host_key(&key_path);
        assert!(
            key_path.exists(),
            "regenerated host key should still be persisted"
        );
        // A valid Ed25519 keypair round-trips through from_bytes.
        let KeypairData::Ed25519(keypair) = keypair else {
            panic!("expected an Ed25519 host key");
        };
        let bytes = keypair.to_bytes();
        assert!(
            Ed25519Keypair::from_bytes(&bytes).is_ok(),
            "regenerated keypair must parse cleanly"
        );
    }
}
