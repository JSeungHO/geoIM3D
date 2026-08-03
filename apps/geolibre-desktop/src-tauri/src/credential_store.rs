//! Device-local credential storage backed by the OS credential manager.
//!
//! Ported from the geoIM3D credential architecture. Credentials never reach the
//! project file, the public runtime environment, or an error string: commands
//! return a fixed non-sensitive code on failure, never the value or a fragment
//! of it.
//!
//! The credential id allowlist is fixed and shared with the frontend
//! (`src/lib/credentials.ts`). An id absent from both lists is rejected, so the
//! webview cannot address arbitrary entries in the user's credential manager.

use std::collections::HashMap;

use serde::Serialize;

const CREDENTIAL_SERVICE: &str = "com.ejbt.geoim3d";

// ponytail: only the credentials the app actually manages today. Adding one is
// a two-line change — this array and CREDENTIAL_IDS in src/lib/credentials.ts,
// which tests/credentials.test.ts asserts stay in sync.
pub(crate) const ALLOWED_CREDENTIAL_IDS: [&str; 2] = ["vworld:api-key", "data-go-kr:service-key"];

const BACKEND_UNAVAILABLE: &str = "credential_backend_unavailable";
const INVALID_ID: &str = "credential_invalid_id";
const INVALID_VALUE: &str = "credential_invalid_value";
const READ_FAILED: &str = "credential_read_failed";
const WRITE_FAILED: &str = "credential_write_failed";
const DELETE_FAILED: &str = "credential_delete_failed";

/// A partial load: the credentials that were read plus a non-sensitive code
/// when at least one entry failed. One unreadable entry must not blank out the
/// rest, or a single corrupt item would make every key look unset.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialLoadResult {
    values: HashMap<String, String>,
    error_code: Option<&'static str>,
}

fn validate_id(credential_id: &str) -> Result<&str, String> {
    if ALLOWED_CREDENTIAL_IDS.contains(&credential_id) {
        Ok(credential_id)
    } else {
        Err(INVALID_ID.to_string())
    }
}

#[cfg(target_os = "windows")]
fn entry(credential_id: &str) -> Result<keyring::Entry, String> {
    let id = validate_id(credential_id)?;
    keyring::Entry::new(CREDENTIAL_SERVICE, id).map_err(|_| BACKEND_UNAVAILABLE.to_string())
}

#[cfg(target_os = "windows")]
fn is_not_found(error: &keyring::Error) -> bool {
    matches!(error, keyring::Error::NoEntry)
}

#[tauri::command]
pub fn credential_load() -> Result<CredentialLoadResult, String> {
    #[cfg(target_os = "windows")]
    {
        let mut values = HashMap::new();
        let mut failed = false;
        for credential_id in ALLOWED_CREDENTIAL_IDS {
            let Ok(entry) = entry(credential_id) else {
                failed = true;
                continue;
            };
            match entry.get_password() {
                Ok(value) if !value.trim().is_empty() => {
                    values.insert(credential_id.to_string(), value);
                }
                Ok(_) => {}
                Err(error) if is_not_found(&error) => {}
                Err(_) => failed = true,
            }
        }
        Ok(CredentialLoadResult {
            values,
            error_code: failed.then_some(READ_FAILED),
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Referenced so the Windows-only constants do not warn as dead code
        // on the targets that cannot reach the credential manager.
        let _ = (CREDENTIAL_SERVICE, READ_FAILED);
        Err(BACKEND_UNAVAILABLE.to_string())
    }
}

#[tauri::command]
pub fn credential_set(credential_id: String, value: String) -> Result<(), String> {
    validate_id(&credential_id)?;
    // An empty value is a rejected write, never an implicit delete: deletion is
    // an explicit user action through credential_delete.
    if value.trim().is_empty() {
        return Err(INVALID_VALUE.to_string());
    }

    #[cfg(target_os = "windows")]
    {
        entry(&credential_id)?
            .set_password(value.trim())
            .map_err(|_| WRITE_FAILED.to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = value;
        let _ = WRITE_FAILED;
        Err(BACKEND_UNAVAILABLE.to_string())
    }
}

#[tauri::command]
pub fn credential_delete(credential_id: String) -> Result<(), String> {
    validate_id(&credential_id)?;

    #[cfg(target_os = "windows")]
    {
        match entry(&credential_id)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(error) if is_not_found(&error) => Ok(()),
            Err(_) => Err(DELETE_FAILED.to_string()),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = DELETE_FAILED;
        Err(BACKEND_UNAVAILABLE.to_string())
    }
}

/// Emergency discard of every managed credential. Best-effort: one failing
/// entry must not stop the sweep, or a single stuck item would strand the rest.
#[tauri::command]
pub fn credential_clear() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut failed = false;
        for credential_id in ALLOWED_CREDENTIAL_IDS {
            let Ok(entry) = entry(credential_id) else {
                failed = true;
                continue;
            };
            match entry.delete_credential() {
                Ok(()) => {}
                Err(error) if is_not_found(&error) => {}
                Err(_) => failed = true,
            }
        }
        if failed {
            Err(DELETE_FAILED.to_string())
        } else {
            Ok(())
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(BACKEND_UNAVAILABLE.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_id_allowlist_accepts_only_product_ids() {
        assert!(validate_id("vworld:api-key").is_ok());
        assert!(validate_id("../../arbitrary").is_err());
        assert!(validate_id("AWS_PROFILE").is_err());
        assert!(validate_id("").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_credential_manager_round_trip() {
        use std::time::{SystemTime, UNIX_EPOCH};

        // A throwaway service/account so the round-trip never touches a real
        // product credential, and the value is never printed.
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be after Unix epoch")
            .as_nanos();
        let account = format!("test:{}:{nonce}", std::process::id());
        let entry = keyring::Entry::new("com.ejbt.geoim3d.test", &account)
            .expect("test credential entry must initialize");
        let value = "geoim3d-credential-round-trip";

        let write_result = entry.set_password(value);
        let read_result = entry.get_password();
        let delete_result = entry.delete_credential();

        assert!(write_result.is_ok(), "Windows credential write failed");
        assert!(
            matches!(read_result.as_deref(), Ok(actual) if actual == value),
            "Windows credential read failed"
        );
        assert!(delete_result.is_ok(), "Windows credential cleanup failed");
    }
}
