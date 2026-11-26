use crate::jwt::sign_access_token;
use crate::types::{AccessTokenPayload, AuthConfig, DeviceInfo, Session, TokenPair};
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[derive(Default)]
struct SessionStore {
    sessions: HashMap<String, Session>,
    grace_started: HashMap<String, Instant>,
}

pub struct InMemorySessionManager {
    config: AuthConfig,
    store: Mutex<SessionStore>,
}

const LAZY_PRUNE_THRESHOLD: usize = 10_000;

impl InMemorySessionManager {
    pub fn new(config: AuthConfig) -> Self {
        Self {
            config,
            store: Mutex::new(SessionStore::default()),
        }
    }

    pub async fn create_session(
        &self,
        user_id: &str,
        device_info: Option<DeviceInfo>,
    ) -> TokenPair {
        let token = Uuid::new_v4().to_string();
        let family_id = Uuid::new_v4().to_string();
        let session_id = Uuid::new_v4().to_string();
        let expiration =
            (Utc::now().timestamp() as u64) + self.config.refresh_token_expiry_days * 86400;

        let session = Session {
            id: session_id.clone(),
            user_id: user_id.to_string(),
            family_id,
            token: token.clone(),
            expiration,
            device_info,
            is_revoked: false,
            replaced_by: None,
            used_at: None,
        };
        {
            let mut store = self.store.lock().unwrap();
            if store.sessions.len() >= LAZY_PRUNE_THRESHOLD {
                Self::prune_locked(&mut store);
            }
            store.sessions.insert(token.clone(), session);
        }
        self.build_pair(token, user_id, &session_id)
    }

    pub async fn refresh_session(
        &self,
        refresh_token: &str,
        device_info: Option<DeviceInfo>,
    ) -> Option<TokenPair> {
        let mut store = self.store.lock().unwrap();
        let session = store.sessions.get(refresh_token)?.clone();
        if session.is_revoked {
            return None;
        }
        let now = Utc::now().timestamp() as u64;
        if now > session.expiration {
            return None;
        }

        // Reuse / replaced path guarded by monotonic grace tracking.
        if let Some(replaced) = &session.replaced_by {
            let grace = Duration::from_secs(self.config.rotation_grace_period_seconds);
            let within_grace = !grace.is_zero()
                && store
                    .grace_started
                    .get(refresh_token)
                    .is_some_and(|started| started.elapsed() <= grace);
            if !within_grace {
                // Out of grace — revoke family.
                let family = session.family_id.clone();
                for s in store.sessions.values_mut() {
                    if s.family_id == family && !s.is_revoked {
                        s.is_revoked = true;
                    }
                }
                return None;
            }
            let replacement = store.sessions.get(replaced)?.clone();
            if replacement.is_revoked
                || replacement.replaced_by.is_some()
                || now > replacement.expiration
            {
                return None;
            }
            return Some(self.build_pair(
                replacement.token.clone(),
                &replacement.user_id,
                &replacement.id,
            ));
        }

        // Rotate.
        let new_token = Uuid::new_v4().to_string();
        let new_session_id = Uuid::new_v4().to_string();
        let expiration = now + self.config.refresh_token_expiry_days * 86400;
        let new_session = Session {
            id: new_session_id.clone(),
            user_id: session.user_id.clone(),
            family_id: session.family_id.clone(),
            token: new_token.clone(),
            expiration,
            device_info,
            is_revoked: false,
            replaced_by: None,
            used_at: None,
        };
        if let Some(existing) = store.sessions.get_mut(refresh_token) {
            existing.replaced_by = Some(new_token.clone());
            existing.used_at = Some(Utc::now().timestamp_micros() as u128);
        }
        store
            .grace_started
            .insert(refresh_token.to_string(), Instant::now());
        store.sessions.insert(new_token.clone(), new_session);
        Some(self.build_pair(new_token, &session.user_id, &new_session_id))
    }

    pub async fn revoke_session(&self, session_id: &str) -> bool {
        let mut store = self.store.lock().unwrap();
        for s in store.sessions.values_mut() {
            if s.id == session_id {
                s.is_revoked = true;
                return true;
            }
        }
        false
    }

    pub async fn revoke_family(&self, family_id: &str) -> usize {
        let mut store = self.store.lock().unwrap();
        let mut count = 0;
        for s in store.sessions.values_mut() {
            if s.family_id == family_id && !s.is_revoked {
                s.is_revoked = true;
                count += 1;
            }
        }
        count
    }

    pub async fn get_user_sessions(&self, user_id: &str) -> Vec<Session> {
        let store = self.store.lock().unwrap();
        let now = Utc::now().timestamp() as u64;
        store
            .sessions
            .values()
            .filter(|s| {
                s.user_id == user_id
                    && !s.is_revoked
                    && s.replaced_by.is_none()
                    && s.expiration > now
            })
            .cloned()
            .collect()
    }

    pub fn cleanup(&self) -> usize {
        let mut store = self.store.lock().unwrap();
        Self::prune_locked(&mut store)
    }

    fn prune_locked(store: &mut SessionStore) -> usize {
        let now = Utc::now().timestamp() as u64;
        let before = store.sessions.len();
        store
            .sessions
            .retain(|_, s| !s.is_revoked && s.expiration > now);
        store
            .grace_started
            .retain(|token, _| store.sessions.contains_key(token));
        before.saturating_sub(store.sessions.len())
    }

    pub async fn revoke_all_user_sessions(&self, user_id: &str) -> usize {
        let mut store = self.store.lock().unwrap();
        let mut count = 0;
        for s in store.sessions.values_mut() {
            if s.user_id == user_id && !s.is_revoked {
                s.is_revoked = true;
                count += 1;
            }
        }
        count
    }

    fn build_pair(&self, refresh_token: String, user_id: &str, session_id: &str) -> TokenPair {
        let iat = Utc::now().timestamp();
        let exp = iat + (self.config.access_token_expiry_minutes as i64) * 60;
        let payload = AccessTokenPayload {
            user_id: user_id.to_string(),
            session_id: session_id.to_string(),
            iat,
            exp,
            claims: None,
        };
        let access_token = sign_access_token(&payload, &self.config)
            .expect("JWT signing should not fail with a valid secret");
        TokenPair {
            access_token,
            refresh_token,
            exp: exp as u64,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> AuthConfig {
        AuthConfig::new("unit-test-secret-that-is-sufficiently-long")
    }

    #[tokio::test]
    async fn create_and_refresh() {
        let m = InMemorySessionManager::new(config());
        let pair = m.create_session("u1", None).await;
        assert!(!pair.refresh_token.is_empty());
        let refreshed = m.refresh_session(&pair.refresh_token, None).await.unwrap();
        assert_ne!(refreshed.refresh_token, pair.refresh_token);
    }

    #[tokio::test]
    async fn out_of_grace_revokes_family() {
        let mut c = config();
        c.rotation_grace_period_seconds = 0;
        let m = InMemorySessionManager::new(c);
        let pair = m.create_session("u1", None).await;
        let _ = m.refresh_session(&pair.refresh_token, None).await;
        assert!(m.refresh_session(&pair.refresh_token, None).await.is_none());
    }

    #[tokio::test]
    async fn revoke_user_sessions() {
        let m = InMemorySessionManager::new(config());
        let _a = m.create_session("u1", None).await;
        let _b = m.create_session("u1", None).await;
        assert_eq!(m.revoke_all_user_sessions("u1").await, 2);
    }

    #[tokio::test]
    async fn grace_reuse_rejects_superseded_and_expired_replacement() {
        let m = InMemorySessionManager::new(config());
        let first = m.create_session("u1", None).await;
        let second = m.refresh_session(&first.refresh_token, None).await.unwrap();
        let third = m
            .refresh_session(&second.refresh_token, None)
            .await
            .unwrap();
        assert!(
            m.refresh_session(&first.refresh_token, None)
                .await
                .is_none()
        );

        let active = m.get_user_sessions("u1").await;
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].token, third.refresh_token);

        assert!(m.revoke_session(&active[0].id).await);
        assert!(m.get_user_sessions("u1").await.is_empty());

        let another = m.create_session("u2", None).await;
        let u2_sessions = m.get_user_sessions("u2").await;
        assert_eq!(m.revoke_family(&u2_sessions[0].family_id).await, 1);
        assert!(
            m.refresh_session(&another.refresh_token, None)
                .await
                .is_none()
        );
        assert!(m.cleanup() >= 2);
    }
}
