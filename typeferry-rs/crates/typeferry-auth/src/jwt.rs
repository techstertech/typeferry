use crate::types::{AccessTokenPayload, AuthConfig};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};

pub fn sign_access_token(
    payload: &AccessTokenPayload,
    config: &AuthConfig,
) -> Result<String, jsonwebtoken::errors::Error> {
    let header = Header::new(config.algorithm.as_jwt());
    encode(
        &header,
        payload,
        &EncodingKey::from_secret(config.secret.as_bytes()),
    )
}

pub fn verify_access_token(token: &str, config: &AuthConfig) -> Option<AccessTokenPayload> {
    let clean = strip_bearer(token);
    let mut validation = Validation::new(config.algorithm.as_jwt());
    validation.set_required_spec_claims(&["exp", "iat"]);
    let decoded = decode::<AccessTokenPayload>(
        clean,
        &DecodingKey::from_secret(config.secret.as_bytes()),
        &validation,
    )
    .ok()?;
    Some(decoded.claims)
}

/// Decode without verifying — inspection only. Callers MUST NOT trust.
pub fn decode_token(token: &str) -> Option<AccessTokenPayload> {
    let clean = strip_bearer(token);
    let decoded = jsonwebtoken::dangerous::insecure_decode::<AccessTokenPayload>(clean).ok()?;
    Some(decoded.claims)
}

fn strip_bearer(token: &str) -> &str {
    if let Some(rest) = token.strip_prefix("Bearer ") {
        return rest;
    }
    if let Some(rest) = token.strip_prefix("bearer ") {
        return rest;
    }
    token
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::JwtAlgorithm;
    use chrono::Utc;
    use serde_json::{Value, json};

    fn config() -> AuthConfig {
        AuthConfig::new("unit-test-secret-that-is-sufficiently-long")
    }

    fn payload() -> AccessTokenPayload {
        let now = Utc::now().timestamp();
        AccessTokenPayload {
            user_id: "u1".into(),
            session_id: "s1".into(),
            iat: now,
            exp: now + 900,
            claims: None,
        }
    }

    #[test]
    fn configured_hmac_algorithms_round_trip() {
        for algorithm in [
            JwtAlgorithm::HS256,
            JwtAlgorithm::HS384,
            JwtAlgorithm::HS512,
        ] {
            let mut config = config();
            config.algorithm = algorithm;

            let token = sign_access_token(&payload(), &config).unwrap();
            let decoded = verify_access_token(&token, &config).unwrap();

            assert_eq!(decoded.user_id, "u1");
            assert_eq!(decoded.session_id, "s1");
        }
    }

    #[test]
    fn bearer_prefix_stripped() {
        let token = sign_access_token(&payload(), &config()).unwrap();
        assert!(verify_access_token(&format!("Bearer {token}"), &config()).is_some());
    }

    #[test]
    fn wrong_secret_fails() {
        let token = sign_access_token(&payload(), &config()).unwrap();
        let mut bad = config();
        bad.secret = "different-secret-that-is-also-long-enough".into();
        assert!(verify_access_token(&token, &bad).is_none());
    }

    #[test]
    fn unconfigured_algorithm_is_rejected() {
        let mut signing_config = config();
        signing_config.algorithm = JwtAlgorithm::HS384;

        let token = sign_access_token(&payload(), &signing_config).unwrap();

        assert!(verify_access_token(&token, &config()).is_none());
    }

    #[test]
    fn expired_token_is_rejected() {
        let mut payload = payload();
        payload.iat -= 900;
        payload.exp = Utc::now().timestamp() - 120;

        let token = sign_access_token(&payload, &config()).unwrap();

        assert!(verify_access_token(&token, &config()).is_none());
    }

    #[test]
    fn missing_timestamp_claims_are_rejected() {
        for claim in ["exp", "iat"] {
            let mut claims = serde_json::to_value(payload()).unwrap();
            claims.as_object_mut().unwrap().remove(claim);

            assert!(verify_access_token(&sign_claims(&claims), &config()).is_none());
        }
    }

    #[test]
    fn malformed_timestamp_claims_are_rejected() {
        for claim in ["exp", "iat"] {
            for value in [Value::Null, json!("not-a-timestamp"), json!({"value": 1})] {
                let mut claims = serde_json::to_value(payload()).unwrap();
                claims[claim] = value;

                assert!(verify_access_token(&sign_claims(&claims), &config()).is_none());
            }
        }
    }

    #[test]
    fn malformed_tokens_are_rejected() {
        for token in ["", "not-a-token", "e30.e30.signature"] {
            assert!(verify_access_token(token, &config()).is_none());
        }
    }

    #[test]
    fn decode_without_verification() {
        let mut payload = payload();
        payload.exp = Utc::now().timestamp() - 120;

        let token = sign_access_token(&payload, &config()).unwrap();
        let claims = decode_token(&token).unwrap();

        assert_eq!(claims.user_id, "u1");
        assert_eq!(claims.exp, payload.exp);
        assert!(verify_access_token(&token, &config()).is_none());
    }

    fn sign_claims(claims: &Value) -> String {
        let config = config();

        encode(
            &Header::new(config.algorithm.as_jwt()),
            claims,
            &EncodingKey::from_secret(config.secret.as_bytes()),
        )
        .unwrap()
    }
}
