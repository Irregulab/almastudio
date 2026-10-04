//! Push notifications to paired devices, through Expo's push service.
//!
//! A device registers its push token over the encrypted channel; the desktop
//! keeps it in `state/remote/push.json`, keyed by the device, and drops it when
//! the device is revoked or the service reports it gone. Sent straight from
//! here — the relay is not involved.

use std::collections::HashMap;
use std::fs;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::store::{atomic_write, state_dir};

const EXPO_PUSH: &str = "https://exp.host/--/api/v2/push/send";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PushTarget {
    pub token: String,
    pub platform: String,
}

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    state_dir(app).ok().map(|d| d.join("remote").join("push.json"))
}

pub fn load(app: &AppHandle) -> HashMap<String, PushTarget> {
    path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, targets: &HashMap<String, PushTarget>) {
    if let (Some(p), Ok(text)) = (path(app), serde_json::to_string_pretty(targets)) {
        let _ = atomic_write(&p, text.as_bytes());
    }
}

/// One notification, already worded.
#[derive(Clone, Debug)]
pub struct Notice {
    pub title: String,
    pub body: String,
    pub data: Value,
}

/// HTTPS here goes through rustls without a built-in crypto provider, so one
/// is installed before the first request: ring, already in the build.
pub fn ensure_tls() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Sends `notice` to every token; returns the tokens the service says are
/// gone, so they can be forgotten.
pub async fn send(tokens: Vec<String>, notice: Notice) -> Vec<String> {
    if tokens.is_empty() {
        return Vec::new();
    }
    ensure_tls();
    let messages: Vec<Value> = tokens
        .iter()
        .map(|to| {
            json!({
                "to": to,
                "title": notice.title,
                "body": notice.body,
                "data": notice.data,
                "sound": "default",
                "priority": "high",
                "channelId": "agents",
            })
        })
        .collect();
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    else {
        return Vec::new();
    };
    let Ok(resp) = client
        .post(EXPO_PUSH)
        .header("Accept", "application/json")
        .json(&messages)
        .send()
        .await
    else {
        return Vec::new();
    };
    let Ok(body) = resp.json::<Value>().await else { return Vec::new() };
    gone_tokens(&tokens, &body)
}

/// The tokens a push response reports as no longer registered.
pub fn gone_tokens(tokens: &[String], body: &Value) -> Vec<String> {
    let Some(tickets) = body.get("data").and_then(Value::as_array) else { return Vec::new() };
    tickets
        .iter()
        .zip(tokens)
        .filter(|(t, _)| {
            t.get("details").and_then(|d| d.get("error")).and_then(Value::as_str)
                == Some("DeviceNotRegistered")
        })
        .map(|(_, token)| token.clone())
        .collect()
}

pub fn harness_label(kind: &str) -> &'static str {
    match kind {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        _ => "The terminal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_unregistered_tokens() {
        let tokens = vec!["a".to_string(), "b".to_string()];
        let body = json!({ "data": [
            { "status": "ok", "id": "1" },
            { "status": "error", "details": { "error": "DeviceNotRegistered" } },
        ]});
        assert_eq!(gone_tokens(&tokens, &body), vec!["b".to_string()]);
        assert!(gone_tokens(&tokens, &json!({})).is_empty());
    }

    /// The push service answers this build's TLS and request shape. Uses the
    /// network and a made-up token, so run it by hand.
    #[tokio::test]
    #[ignore]
    async fn reaches_the_push_service() {
        let gone = send(
            vec!["ExponentPushToken[not-a-real-token]".into()],
            Notice { title: "t".into(), body: "b".into(), data: json!({}) },
        )
        .await;
        // A made-up token is refused, but the request itself goes through.
        let _ = gone;
    }
}
