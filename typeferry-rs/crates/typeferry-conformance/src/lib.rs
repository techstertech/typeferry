//! Helpers for replaying `docs/conformance/fixtures/*` against the
//! Rust runtime. Mirror of `typeferry-py/tests/conformance/harness.py`
//! and `typeferry-ts/src/test/conformance/harness.ts`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use chrono::{TimeZone, Utc};
use futures::FutureExt as _;
use serde_json::{Map, Value, json};
use typeferry_ejson::{EjsonValue, InfNaNSign, Regex};
use typeferry_runtime::error::PublicError;
use typeferry_runtime::method::BoxResult;
use typeferry_runtime::{
    AuthFn, ClientNode, MethodOptions, RpcHandler, SchemaValidator, Server, ValidationIssue,
    ValidationResult,
};

/// Repo-relative root for the shared fixture set.
pub fn fixtures_root() -> PathBuf {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    crate_dir
        .join("..")
        .join("..")
        .join("..")
        .join("docs")
        .join("conformance")
        .join("fixtures")
}

pub fn list_cases(subdir: &str, suffix: &str) -> Vec<PathBuf> {
    let dir = fixtures_root().join(subdir);
    let mut entries: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("fixture dir readable")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.ends_with(suffix))
                .unwrap_or(false)
        })
        .collect();
    entries.sort();
    entries
}

pub fn load_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).expect("fixture file readable");
    serde_json::from_str(&text).expect("fixture is valid JSON")
}

pub fn load_ndjson(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .expect("fixture file readable")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("ndjson line valid"))
        .collect()
}

// ---------------------------------------------------------------------------
// EJSON tagged-value rehydration
// ---------------------------------------------------------------------------

/// Custom-type marker used by EJSON `custom` fixture cases. We don't
/// need a registry: the conformance test only encodes via EjsonValue,
/// which renders a `$type/$value` envelope directly without consulting
/// any global state.
#[derive(Debug, Clone)]
pub struct FixtureCustom {
    pub type_name: String,
    pub inner: EjsonValue,
}

pub fn rehydrate(node: &Value) -> EjsonValue {
    let kind = node
        .get("__kind")
        .and_then(|v| v.as_str())
        .expect("fixture node missing __kind");
    match kind {
        "null" => EjsonValue::Null,
        "bool" => EjsonValue::Bool(node["value"].as_bool().unwrap()),
        "int" => EjsonValue::Int(node["value"].as_i64().unwrap()),
        "float" => EjsonValue::Float(node["value"].as_f64().unwrap()),
        "string" => EjsonValue::String(node["value"].as_str().unwrap().into()),
        "array" => {
            let items = node["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(rehydrate)
                .collect();
            EjsonValue::Array(items)
        }
        "object" => {
            // EjsonMap preserves insertion order so the encoded output
            // matches the fixture's `encoded` field byte-for-byte
            // (TS / Python emit object keys in insertion order).
            let mut out = typeferry_ejson::value::EjsonMap::new();
            for entry in node["entries"].as_array().unwrap() {
                let pair = entry.as_array().unwrap();
                let key = pair[0].as_str().unwrap().to_string();
                out.insert(key, rehydrate(&pair[1]));
            }
            EjsonValue::Object(out)
        }
        "date" => {
            let ms = node["millis"].as_i64().unwrap();
            EjsonValue::Date(Utc.timestamp_millis_opt(ms).unwrap())
        }
        "binary" => {
            let b64 = node["base64"].as_str().unwrap();
            let bytes = typeferry_ejson::base64::decode(b64).expect("valid base64");
            EjsonValue::Binary(bytes)
        }
        "regex" => EjsonValue::Regex(Regex {
            source: node["source"].as_str().unwrap().into(),
            flags: node["flags"].as_str().unwrap().into(),
        }),
        "inf_nan" => match node["sign"].as_i64().unwrap() {
            0 => EjsonValue::InfNaN(InfNaNSign::NaN),
            1 => EjsonValue::InfNaN(InfNaNSign::PositiveInfinity),
            _ => EjsonValue::InfNaN(InfNaNSign::NegativeInfinity),
        },
        "custom" => EjsonValue::Custom {
            name: node["type"].as_str().unwrap().into(),
            value: Box::new(rehydrate(&node["inner"])),
        },
        other => panic!("unknown __kind: {other}"),
    }
}

// ---------------------------------------------------------------------------
// Server fixture: setup-block interpretation
// ---------------------------------------------------------------------------

pub fn build_handler(spec: &str) -> RpcHandler {
    if spec == "increment_counter" {
        let calls = Arc::new(AtomicUsize::new(0));
        return Arc::new(move |_node, _params| {
            let calls = calls.clone();
            async move { Ok(json!(calls.fetch_add(1, Ordering::Relaxed) + 1)) }.boxed()
        });
    }
    if spec == "echo_params" {
        return Arc::new(|_n, p| async move { Ok(p) }.boxed());
    }
    if spec == "add_two_integers" {
        return Arc::new(|_n, p: Value| {
            async move {
                let a = p.get("a").and_then(|v| v.as_i64()).unwrap_or(0);
                let b = p.get("b").and_then(|v| v.as_i64()).unwrap_or(0);
                Ok(json!(a + b))
            }
            .boxed()
        });
    }
    if spec == "return_user_id" {
        return Arc::new(|node: Arc<ClientNode>, _p| {
            async move {
                let user_id = node
                    .user_id
                    .read()
                    .ok()
                    .and_then(|opt| opt.clone())
                    .unwrap_or_else(|| "anon".to_string());
                Ok(json!(user_id)) as BoxResult
            }
            .boxed()
        });
    }
    if let Some(value) = spec.strip_prefix("return_const:") {
        let owned = value.to_string();
        return Arc::new(move |_n, _p| {
            let v = owned.clone();
            async move { Ok(json!(v)) as BoxResult }.boxed()
        });
    }
    if let Some(message) = spec.strip_prefix("raise_public:") {
        let owned = message.to_string();
        return Arc::new(move |_n, _p| {
            let msg = owned.clone();
            async move {
                Err(typeferry_runtime::TypeFerryError::Public(PublicError::new(
                    msg,
                )))
            }
            .boxed()
        });
    }
    panic!("unknown handler spec: {spec}");
}

struct FixtureSchema {
    issues: Vec<ValidationIssue>,
}

impl SchemaValidator for FixtureSchema {
    fn safe_parse(&self, _value: &Value) -> ValidationResult {
        ValidationResult::failure(self.issues.clone())
    }
}

pub fn build_schema(spec: Option<&Value>) -> Option<Arc<dyn SchemaValidator>> {
    let spec = spec?;
    if !spec
        .get("reject_all")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return None;
    }
    let issues: Vec<ValidationIssue> = spec
        .get("issues")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|i| ValidationIssue {
                    path: i["path"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|p| p.as_str().unwrap().to_string())
                        .collect(),
                    message: i["message"].as_str().unwrap().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Arc::new(FixtureSchema { issues }))
}

pub fn build_auth(accept_token: String, user: Value) -> AuthFn {
    Arc::new(move |_node: Arc<ClientNode>, ctx: Value| {
        let accept = accept_token.clone();
        let user = user.clone();
        async move {
            let token = ctx
                .get("token")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if token == accept {
                let mut wrapper = Map::new();
                wrapper.insert("user".into(), user);
                Value::Object(wrapper)
            } else {
                Value::Null
            }
        }
        .boxed()
    })
}

pub fn configure_server(server: &Arc<Server>, setup: Option<&Value>) {
    let Some(setup) = setup else { return };
    if let Some(methods) = setup.get("methods").and_then(|v| v.as_array()) {
        for spec in methods {
            let name = spec["name"].as_str().unwrap().to_string();
            let handler = build_handler(spec["handler"].as_str().unwrap());
            let schema = build_schema(spec.get("schema"));
            let opts = MethodOptions {
                cache: spec.get("cache").and_then(|v| v.as_bool()).unwrap_or(false),
                protected: spec
                    .get("protected")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                schema,
                ..Default::default()
            };
            server.add_method(&name, handler, opts);
        }
    }
    if let Some(events) = setup.get("events").and_then(|v| v.as_array()) {
        for spec in events {
            let name = spec["name"].as_str().unwrap().to_string();
            server.add_event(typeferry_runtime::Event::new(
                &name,
                typeferry_runtime::EventOptions::default(),
            ));
        }
    }
    if let Some(auth) = setup.get("auth") {
        let token = auth["accept_token"].as_str().unwrap().to_string();
        let user = auth["user"].clone();
        server.set_auth(build_auth(token, user));
    }
}
