//! Signed App packages: what the instance trusts, and verifying a package
//! before its bundle runs.
//!
//! `AppView` loads bundles, not packages, so this module verifies each
//! package with `nsh-package` (through `nsh_engine::verify_package`: the
//! release key's certificate from a root the instance named, the signature,
//! every file's hash, the revocation list, and no build older than one this
//! app accepted) and hands on the verified bundle. The roots and the
//! revocation list come from the instance the person signed in to
//! (`AppService.GetAppRuntimeTrust`); the builds accepted and the newest
//! revocation list persist per instance, so a package cache or a replayed
//! answer can never take an App back to an older build.

use nsh_engine::LoadedPackage;
use nsh_package::{PublicKey, Revocations, TrustStore};
use serde::Deserialize;
use std::path::Path;

use super::grant;

/// The NSH app id of a Hatch App (`nshAppId` in `src/app-native-config.ts`):
/// `x`, `-` and anything else outside `[a-wyz0-9]` become `x` plus two hex
/// digits, so the mapping is reversible.
pub fn nsh_app_id(app_id: &str) -> String {
    let mut encoded = String::with_capacity(app_id.len() + 8);
    for ch in app_id.chars() {
        if matches!(ch, 'a'..='w' | 'y' | 'z' | '0'..='9') {
            encoded.push(ch);
        } else {
            encoded.push_str(&format!("x{:02x}", ch as u32));
        }
    }
    format!("dev.hatch.app.{encoded}")
}

/// `AppRuntimeTrust` as the instance answers it (Connect JSON).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimeTrust {
    pub initialized: bool,
    pub roots: Vec<TrustRoot>,
    pub revocations: Option<RuntimeRevocations>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustRoot {
    pub key_id: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRevocations {
    /// The list as the root signed it.
    pub signed: String,
}

/// Opens the trust store kept for one instance in `dir`, trusting what the
/// instance names now: its roots, and its revocation list when it is newer
/// than the one kept.
pub fn open_store(dir: &Path, trust: &RuntimeTrust) -> Result<TrustStore, String> {
    if !trust.initialized || trust.roots.is_empty() {
        return Err("The instance has not created its signing keys yet.".into());
    }
    let mut store = TrustStore::open(dir).map_err(|e| e.to_string())?;
    for root in &trust.roots {
        let key = PublicKey::from_base64(&root.public_key).map_err(|e| e.to_string())?;
        if key.id() != root.key_id {
            return Err(format!("Root key {} does not match its id.", root.key_id));
        }
        store.add_root(key);
    }
    if let Some(revocations) = &trust.revocations {
        let list = Revocations::from_json(&revocations.signed).map_err(|e| e.to_string())?;
        match store.update_revocations(list) {
            Ok(_) | Err(nsh_package::Error::StaleRevocations { .. }) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(store)
}

/// Verifies `bytes` as the package of Hatch App `app_id`, writes its assets
/// under `assets_root` and records its build: older builds of the App are
/// refused from now on (a rollback is a newer build of older code). The
/// bundle runs under the bridge's grant ([`grant::policy`]).
pub fn load(
    store: &mut TrustStore,
    app_id: &str,
    bytes: &[u8],
    assets_root: &Path,
) -> Result<LoadedPackage, String> {
    let mut loaded = nsh_engine::verify_package(store, bytes, assets_root)?;
    let expected = nsh_app_id(app_id);
    if loaded.app.id != expected {
        return Err(format!(
            "The package is signed for {}, not for this App ({expected}).",
            loaded.app.id
        ));
    }
    nsh_engine::accept_package(store, &loaded)?;
    loaded.bundle.policy = grant::policy(loaded.bundle.policy.clone());
    Ok(loaded)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use nsh_package::{certify, revoke, App, Contents, SecretKey};

    /// An instance's keys, as the platform makes them.
    pub struct Keys {
        pub root: SecretKey,
        pub release: SecretKey,
        pub certificate: nsh_package::Certificate,
    }

    impl Keys {
        pub fn new() -> Keys {
            let root = SecretKey::generate().unwrap();
            let release = SecretKey::generate().unwrap();
            let certificate = certify(
                &root,
                &release.public(),
                &["dev.hatch.app.*".to_owned()],
                0,
                u64::MAX / 2,
            );
            Keys {
                root,
                release,
                certificate,
            }
        }

        pub fn trust(&self, revocations: Option<Revocations>) -> RuntimeTrust {
            let root = self.root.public();
            RuntimeTrust {
                initialized: true,
                roots: vec![TrustRoot {
                    key_id: root.id(),
                    public_key: root.to_base64(),
                }],
                revocations: revocations.map(|list| RuntimeRevocations {
                    signed: list.to_json(),
                }),
            }
        }

        pub fn package(
            &self,
            app_id: &str,
            build: u64,
            capabilities: serde_json::Value,
        ) -> Vec<u8> {
            nsh_package::build(
                &Contents {
                    app: App {
                        id: nsh_app_id(app_id),
                        name: "Field Notes".into(),
                        version: "1.0.0".into(),
                        build,
                    },
                    capabilities: Some(capabilities),
                    source: "globalThis.started = true;".into(),
                    bytecode: None,
                    source_map: None,
                    assets: vec![("icons/leaf.txt".into(), b"leaf".to_vec())],
                    min_runtime: None,
                },
                &self.release,
                &self.certificate,
            )
            .unwrap()
        }
    }

    fn platform_capabilities() -> serde_json::Value {
        serde_json::json!({
            "network": { "hosts": [], "http": [] },
            "clipboard": false,
            "openUrl": false,
            "host": grant::HOST_CALLS,
        })
    }

    const APP: &str = "01m8f6110hdf7rm7hbgrh239ae";

    struct Dirs {
        _tmp: tempfile::TempDir,
        trust: std::path::PathBuf,
        assets: std::path::PathBuf,
    }

    fn dirs() -> Dirs {
        let tmp = tempfile::tempdir().unwrap();
        Dirs {
            trust: tmp.path().join("trust"),
            assets: tmp.path().join("assets"),
            _tmp: tmp,
        }
    }

    #[test]
    fn nsh_ids_match_the_platform() {
        assert_eq!(nsh_app_id("habit-tracker"), "dev.hatch.app.habitx2dtracker");
        assert_eq!(nsh_app_id("box"), "dev.hatch.app.box78");
        assert_eq!(nsh_app_id(APP), "dev.hatch.app.01m8f6110hdf7rm7hbgrh239ae");
    }

    #[test]
    fn loads_a_package_the_instance_signed_under_the_grant() {
        let keys = Keys::new();
        let dirs = dirs();
        let mut store = open_store(&dirs.trust, &keys.trust(None)).unwrap();
        let loaded = load(
            &mut store,
            APP,
            &keys.package(APP, 3, platform_capabilities()),
            &dirs.assets,
        )
        .unwrap();
        assert_eq!(loaded.app.build, 3);
        assert_eq!(
            std::fs::read(loaded.assets.join("icons/leaf.txt")).unwrap(),
            b"leaf"
        );
        let access = loaded.bundle.policy.access();
        assert!(access.allows_host("hatch.rpc"));
        assert!(!access.allows_http("GET", "https://example.com/"));
        // The build is recorded across launches.
        let store = open_store(&dirs.trust, &keys.trust(None)).unwrap();
        assert_eq!(store.accepted_build(&nsh_app_id(APP)), Some(3));
    }

    #[test]
    fn a_greedy_package_gets_only_the_grant() {
        let keys = Keys::new();
        let dirs = dirs();
        let mut store = open_store(&dirs.trust, &keys.trust(None)).unwrap();
        let greedy = serde_json::json!({
            "network": { "hosts": ["*"], "http": ["*"] },
            "clipboard": true,
            "openUrl": true,
            "fs": { "read": ["*"], "write": ["*"] },
            "host": ["*"],
        });
        let loaded = load(&mut store, APP, &keys.package(APP, 1, greedy), &dirs.assets).unwrap();
        let access = loaded.bundle.policy.access();
        assert!(!access.allows_http("GET", "https://example.com/"));
        assert!(!access.allows_clipboard());
        assert!(!access.allows_open_url("https://example.com/"));
        assert!(!access.allows_host("hatch.native.camera.take"));
        assert!(access.allows_host("hatch.data.query"));
    }

    #[test]
    fn refuses_a_package_signed_with_a_forged_key() {
        let keys = Keys::new();
        // Another root certified this release key: not one the instance names.
        let forger = Keys::new();
        let dirs = dirs();
        let mut store = open_store(&dirs.trust, &keys.trust(None)).unwrap();
        let error = load(
            &mut store,
            APP,
            &forger.package(APP, 9, platform_capabilities()),
            &dirs.assets,
        )
        .expect_err("forged package");
        assert!(error.contains("not trusted"), "{error}");
        // A key the instance's root never certified, with a certificate it forged.
        let rogue = SecretKey::generate().unwrap();
        let forged_certificate = certify(
            &forger.root,
            &rogue.public(),
            &["dev.hatch.app.*".into()],
            0,
            u64::MAX / 2,
        );
        let forged = nsh_package::build(
            &Contents {
                app: App {
                    id: nsh_app_id(APP),
                    name: "x".into(),
                    version: "1.0.0".into(),
                    build: 10,
                },
                capabilities: None,
                source: String::new(),
                bytecode: None,
                source_map: None,
                assets: vec![],
                min_runtime: None,
            },
            &rogue,
            &forged_certificate,
        )
        .unwrap();
        assert!(load(&mut store, APP, &forged, &dirs.assets).is_err());
        assert_eq!(store.accepted_build(&nsh_app_id(APP)), None);
    }

    #[test]
    fn refuses_packages_of_a_revoked_key_or_revoked_packages() {
        let keys = Keys::new();
        let dirs = dirs();
        let package = keys.package(APP, 2, platform_capabilities());
        let revoked_key = revoke(&keys.root, 2, &[keys.release.public().id()], &[]);
        let mut store = open_store(&dirs.trust, &keys.trust(Some(revoked_key))).unwrap();
        let error = load(&mut store, APP, &package, &dirs.assets).expect_err("revoked key");
        assert!(error.contains("revoked"), "{error}");

        let other = Keys::new();
        let dirs = super::tests::dirs();
        let package = other.package(APP, 2, platform_capabilities());
        let sha = {
            use sha2::Digest;
            hex(&sha2::Sha256::digest(&package))
        };
        let revoked_package = revoke(&other.root, 2, &[], &[sha]);
        let mut store = open_store(&dirs.trust, &other.trust(Some(revoked_package))).unwrap();
        let error = load(&mut store, APP, &package, &dirs.assets).expect_err("revoked package");
        assert!(error.contains("revoked"), "{error}");
    }

    #[test]
    fn a_revocation_list_signed_elsewhere_is_refused() {
        let keys = Keys::new();
        let forger = Keys::new();
        let dirs = dirs();
        let list = revoke(&forger.root, 5, &[], &[]);
        assert!(open_store(&dirs.trust, &keys.trust(Some(list))).is_err());
    }

    #[test]
    fn refuses_an_older_build_and_another_apps_package() {
        let keys = Keys::new();
        let dirs = dirs();
        let mut store = open_store(&dirs.trust, &keys.trust(None)).unwrap();
        load(
            &mut store,
            APP,
            &keys.package(APP, 5, platform_capabilities()),
            &dirs.assets,
        )
        .unwrap();
        let error = load(
            &mut store,
            APP,
            &keys.package(APP, 4, platform_capabilities()),
            &dirs.assets,
        )
        .expect_err("older build");
        assert!(error.contains("older"), "{error}");
        // A valid package of another App never runs as this one.
        let error = load(
            &mut store,
            APP,
            &keys.package("trail-log", 9, platform_capabilities()),
            &dirs.assets,
        )
        .expect_err("other app");
        assert!(error.contains("not for this App"), "{error}");
        assert_eq!(store.accepted_build(&nsh_app_id("trail-log")), None);
    }

    #[test]
    fn refuses_a_tampered_package() {
        let keys = Keys::new();
        let dirs = dirs();
        let mut store = open_store(&dirs.trust, &keys.trust(None)).unwrap();
        let mut package = keys.package(APP, 1, platform_capabilities());
        let last = package.len() - 1;
        package[last] ^= 0xff;
        assert!(load(&mut store, APP, &package, &dirs.assets).is_err());
    }

    #[test]
    fn needs_initialized_trust() {
        let dirs = dirs();
        assert!(open_store(&dirs.trust, &RuntimeTrust::default()).is_err());
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}
