//! Auth primitives — JWT, cookies, sessions.
//!
//! OAuth providers are feature-gated: enable `oauth-google` for the
//! Google provider.

pub mod cookies;
pub mod jwt;
pub mod sessions;
pub mod types;

pub use cookies::{clear_refresh_token_cookie, set_refresh_token_cookie};
pub use jwt::{decode_token, sign_access_token, verify_access_token};
pub use sessions::InMemorySessionManager;
pub use types::{
    AccessTokenPayload, AuthConfig, AuthContext, CookieOptions, DeviceInfo, JwtAlgorithm, Session,
    TokenPair,
};

use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn now_unix_secs() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_secs()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_secs()).unwrap_or(i64::MAX),
    }
}

pub(crate) fn now_unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}
