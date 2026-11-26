use crate::types::CookieOptions;

fn default_secure() -> bool {
    std::env::var("NODE_ENV")
        .map(|v| v == "production")
        .unwrap_or(false)
}

fn sanitize_cookie_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|&c| {
            c.is_ascii_graphic()
                && !matches!(
                    c,
                    '(' | ')'
                        | '<'
                        | '>'
                        | '@'
                        | ','
                        | ';'
                        | ':'
                        | '\\'
                        | '"'
                        | '/'
                        | '['
                        | ']'
                        | '?'
                        | '='
                        | '{'
                        | '}'
                )
        })
        .collect();
    if cleaned.is_empty() {
        "bf_refresh".into()
    } else {
        cleaned
    }
}

fn sanitize_cookie_path(path: &str) -> String {
    let cleaned: String = path
        .chars()
        .filter(|&c| c.is_ascii() && !c.is_control() && c != ';')
        .collect();
    if cleaned.starts_with('/') {
        cleaned
    } else {
        "/".into()
    }
}

pub fn set_refresh_token_cookie(token: &str, options: &CookieOptions) -> String {
    let max_age = options.max_age_days * 24 * 60 * 60;
    let secure = options.secure.unwrap_or_else(default_secure);
    let encoded = urlencode(token);
    let name = sanitize_cookie_name(&options.name);
    let path = sanitize_cookie_path(&options.path);

    let mut parts = vec![
        format!("{name}={encoded}"),
        "HttpOnly".into(),
        format!("Path={path}"),
        format!("Max-Age={max_age}"),
        format!("SameSite={}", options.same_site.as_str()),
    ];
    if secure {
        parts.push("Secure".into());
    }
    parts.join("; ")
}

pub fn clear_refresh_token_cookie(name: &str, path: &str, secure: Option<bool>) -> String {
    let secure = secure.unwrap_or_else(default_secure);
    let name = sanitize_cookie_name(name);
    let path = sanitize_cookie_path(path);
    let mut parts = vec![
        format!("{name}="),
        "HttpOnly".into(),
        format!("Path={path}"),
        "Max-Age=0".into(),
        "SameSite=Lax".into(),
    ];
    if secure {
        parts.push("Secure".into());
    }
    parts.join("; ")
}

fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn default_flags() {
        let _guard = ENV_LOCK.lock().unwrap();
        // SAFETY: serialized under ENV_LOCK so parallel unit tests never race on NODE_ENV.
        unsafe { std::env::remove_var("NODE_ENV") };
        let header = set_refresh_token_cookie("tok", &CookieOptions::new("bf_refresh", 7));
        assert!(header.starts_with("bf_refresh=tok"));
        assert!(header.contains("HttpOnly"));
        assert!(header.contains("Path=/"));
        assert!(header.contains("Max-Age=604800"));
        assert!(header.contains("SameSite=Lax"));
        assert!(!header.contains("Secure"));
    }

    #[test]
    fn sanitizes_attribute_injection_characters() {
        let _guard = ENV_LOCK.lock().unwrap();
        let mut opts = CookieOptions::new("bad;name=\r\nEvil", 7);
        opts.path = "/;Domain=evil.test\r\n".into();
        let header = set_refresh_token_cookie("tok", &opts);
        assert!(header.starts_with("badnameEvil=tok"));
        assert!(!header.contains('\r'));
        assert!(!header.contains('\n'));
        assert!(header.contains("Path=/Domain=evil.test;"));
    }

    #[test]
    fn urlencode_escapes_specials() {
        assert_eq!(urlencode("a=b;c"), "a%3Db%3Bc");
    }

    #[test]
    fn clear_sets_max_age_zero() {
        let header = clear_refresh_token_cookie("bf_refresh", "/", Some(false));
        assert!(header.contains("Max-Age=0"));
    }

    #[test]
    fn empty_or_invalid_name_and_unrooted_path_fall_back_safely() {
        let _guard = ENV_LOCK.lock().unwrap();
        let mut opts = CookieOptions::new("()<>@,;:\\\"/[]?={}", 7);
        opts.path = "not-rooted".into();
        let header = set_refresh_token_cookie("tok", &opts);
        assert!(header.starts_with("bf_refresh=tok"));
        assert!(header.contains("Path=/;"));
    }
}
