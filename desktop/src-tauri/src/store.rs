//! What the app remembers. The session token lives only in the macOS
//! Keychain; the settings file holds nothing secret (which instance, its
//! accent colour).

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

const KEYCHAIN_SERVICE: &str = "app.hatch.desktop.session";

/// The Hatch session token for one instance, one Keychain item per origin.
pub mod keychain {
    use super::KEYCHAIN_SERVICE;
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    /// errSecItemNotFound
    const NOT_FOUND: i32 = -25300;

    pub fn get(origin: &str) -> Result<Option<String>, String> {
        match get_generic_password(KEYCHAIN_SERVICE, origin) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "The saved session is unreadable.".to_owned()),
            Err(error) if error.code() == NOT_FOUND => Ok(None),
            Err(error) => Err(format!("Keychain: {error}")),
        }
    }

    pub fn set(origin: &str, token: &str) -> Result<(), String> {
        set_generic_password(KEYCHAIN_SERVICE, origin, token.as_bytes())
            .map_err(|error| format!("Keychain: {error}"))
    }

    pub fn remove(origin: &str) -> Result<(), String> {
        match delete_generic_password(KEYCHAIN_SERVICE, origin) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == NOT_FOUND => Ok(()),
            Err(error) => Err(format!("Keychain: {error}")),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Canonical origin of the instance this app shows.
    pub instance: Option<String>,
    /// The instance's accent as `#RRGGBB`, last read from ThemeService.
    pub accent: Option<String>,
}

pub struct SettingsFile(PathBuf);

impl SettingsFile {
    pub fn new(dir: PathBuf) -> Self {
        Self(dir.join("settings.json"))
    }

    pub fn load(&self) -> Settings {
        fs::read(&self.0)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, settings: &Settings) -> Result<(), String> {
        if let Some(dir) = self.0.parent() {
            fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        }
        let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
        // Write then rename, so a crash never leaves half a file.
        let temporary = self.0.with_extension("json.tmp");
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        fs::rename(&temporary, &self.0).map_err(|error| error.to_string())
    }
}
