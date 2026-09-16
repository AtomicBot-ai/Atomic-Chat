//! What the core currently has loaded, mirrored into the app.
//!
//! Before the core existed, "where is model X served?" was answered by locking the llama.cpp
//! plugin's own `HashMap` — the process that owned the session also owned the answer. With the core
//! owning sessions, the answer lives in another process, and the app keeps a mirror fed by the
//! registration snapshot plus the event stream.
//!
//! A mirror of a remote process is only useful if it can say "I am out of date". That is what the
//! generation is for: it is the supervisor's attachment counter, and every read carries it. When the
//! core dies, the supervisor moves on and this mirror is emptied — because the alternative, which
//! the app shipped with for years in three separate caches, is handing out a port number that now
//! belongs to nothing, or worse, to whatever process next took that port.
//!
//! The inventory that led here (PLAN.md §0, 2026-09-16) found three such caches — the extension's
//! `sessionCache`, the web-app's `ModelFactory.localSessionCache`, and the port captured inside the
//! AI-SDK model object's closures — each of which could outlive the session it described.

use std::collections::HashMap;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::server::proxy::model_ids_match;

/// One loaded model, in the shape the app already passes around.
///
/// Field names match the plugin's `SessionInfo` so a resolved session can stand in for one without
/// a translation layer at every call site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoreSession {
    pub pid: i32,
    pub port: i32,
    pub model_id: String,
    #[serde(default)]
    pub model_path: String,
    #[serde(default)]
    pub is_embedding: bool,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub mmproj_path: Option<String>,
    /// `llamacpp-upstream`, `llamacpp`, `mlx`, … — which runtime inside the core holds it.
    #[serde(default = "default_provider")]
    pub provider: String,
}

fn default_provider() -> String {
    "llamacpp-upstream".to_string()
}

impl CoreSession {
    /// Where this model answers. The core binds loopback only, as the plugin did.
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn has_vision(&self) -> bool {
        self.mmproj_path.is_some()
    }
}

#[derive(Debug, Default)]
struct Mirror {
    /// The supervisor attachment this mirror belongs to. `None` when nothing is attached.
    generation: Option<u64>,
    instance_id: String,
    by_model: HashMap<String, CoreSession>,
}

/// The app's copy of the core's session table.
#[derive(Debug, Default)]
pub struct CoreSessions {
    inner: RwLock<Mirror>,
}

impl CoreSessions {
    pub fn new() -> Self {
        Self::default()
    }

    /// The generation this mirror describes, or `None` when it describes nothing.
    pub fn generation(&self) -> Option<u64> {
        self.inner.read().expect("core sessions").generation
    }

    pub fn instance_id(&self) -> Option<String> {
        let mirror = self.inner.read().expect("core sessions");
        mirror.generation.map(|_| mirror.instance_id.clone())
    }

    /// Replace everything with a snapshot taken at `generation`.
    ///
    /// A snapshot from an older generation is dropped: it describes a core the app has already
    /// stopped talking to, and applying it would resurrect dead ports.
    pub fn apply_snapshot(&self, generation: u64, instance_id: &str, snapshot: &Value) -> bool {
        let mut mirror = self.inner.write().expect("core sessions");
        if mirror
            .generation
            .is_some_and(|current| generation < current)
        {
            return false;
        }
        mirror.generation = Some(generation);
        mirror.instance_id = instance_id.to_string();
        mirror.by_model = parse_sessions(snapshot)
            .into_iter()
            .map(|session| (session.model_id.clone(), session))
            .collect();
        true
    }

    /// Apply one core event. Unknown events are ignored — this mirror tracks sessions, and the
    /// relay forwards everything else to the webview unchanged.
    pub fn apply_event(&self, generation: u64, name: &str, payload: &Value) -> bool {
        let mut mirror = self.inner.write().expect("core sessions");
        if mirror.generation != Some(generation) {
            // An event from a core we are no longer attached to, or from before the snapshot that
            // established this mirror. Either way it describes a table we do not hold.
            return false;
        }
        match name {
            "session:started" => match serde_json::from_value::<CoreSession>(payload.clone()) {
                Ok(session) => {
                    mirror.by_model.insert(session.model_id.clone(), session);
                    true
                }
                Err(e) => {
                    log::debug!("[atomic-core] session:started was not a session: {e}");
                    false
                }
            },
            "session:died" | "session:unloaded" => {
                let Some(model_id) = payload.get("model_id").and_then(Value::as_str) else {
                    return false;
                };
                mirror.by_model.remove(model_id).is_some()
            }
            _ => false,
        }
    }

    /// Apply an event to whatever generation this mirror currently holds.
    ///
    /// Safe because of the order the relay emits in: it installs a snapshot before it reads a
    /// single frame, and it emits `detached` before it gives up on an attachment. So every session
    /// event the app sees falls between those two, and belongs to the generation in between. With
    /// nothing attached the mirror holds no generation and the event is dropped, which is the right
    /// answer for an event about a core the app is no longer following.
    pub fn apply_current_event(&self, name: &str, payload: &Value) -> bool {
        let Some(generation) = self.generation() else {
            return false;
        };
        self.apply_event(generation, name, payload)
    }

    /// Forget everything, because the attachment did.
    pub fn invalidate(&self, generation: u64) -> bool {
        let mut mirror = self.inner.write().expect("core sessions");
        if mirror.generation != Some(generation) {
            return false;
        }
        *mirror = Mirror::default();
        true
    }

    /// Find a loaded model.
    ///
    /// Matching is the proxy's `model_ids_match`, not string equality: some clients and some
    /// filesystems swap `.` for `_`, so `Qwen3_5-9B` and `Qwen3.5-9B` name the same model. The core
    /// path has to answer those requests the same way the plugin path always has, or migrating a
    /// user to the core would silently break the models whose names contain a dot.
    pub fn find(&self, model_id: &str) -> Option<CoreSession> {
        let mirror = self.inner.read().expect("core sessions");
        mirror
            .by_model
            .get(model_id)
            .or_else(|| {
                mirror
                    .by_model
                    .values()
                    .find(|s| model_ids_match(&s.model_id, model_id))
            })
            .cloned()
    }

    pub fn find_by_provider(&self, provider: &str, model_id: &str) -> Option<CoreSession> {
        self.find(model_id)
            .filter(|session| session.provider == provider)
    }

    /// An embedding session, preferring `preferred` when it is loaded.
    ///
    /// The app's RAG bridge asks for "something that can embed"; which model that is depends on
    /// what happens to be loaded.
    pub fn find_embedding(&self, preferred: &str) -> Option<CoreSession> {
        let mirror = self.inner.read().expect("core sessions");
        mirror
            .by_model
            .get(preferred)
            .filter(|s| s.is_embedding)
            .cloned()
            .or_else(|| mirror.by_model.values().find(|s| s.is_embedding).cloned())
    }

    pub fn list(&self) -> Vec<CoreSession> {
        let mut sessions: Vec<CoreSession> = self
            .inner
            .read()
            .expect("core sessions")
            .by_model
            .values()
            .cloned()
            .collect();
        // Stable order: `/models` and the UI should not reshuffle between reads.
        sessions.sort_by(|a, b| a.model_id.cmp(&b.model_id));
        sessions
    }

    pub fn loaded_model_ids(&self) -> Vec<String> {
        self.list().into_iter().map(|s| s.model_id).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.inner
            .read()
            .expect("core sessions")
            .by_model
            .is_empty()
    }
}

/// Pull the session list out of a control snapshot, skipping entries that are not sessions.
///
/// Tolerant on purpose: a newer core may add fields, and one unreadable entry must not cost the app
/// every other session in the table.
fn parse_sessions(snapshot: &Value) -> Vec<CoreSession> {
    let Some(entries) = snapshot.get("sessions").and_then(Value::as_array) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| serde_json::from_value::<CoreSession>(entry.clone()).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session(model_id: &str, port: i32) -> Value {
        json!({
            "pid": 100,
            "port": port,
            "model_id": model_id,
            "model_path": format!("/models/{model_id}.gguf"),
            "is_embedding": false,
            "api_key": "k",
            "provider": "llamacpp-upstream",
        })
    }

    fn snapshot(sessions: Vec<Value>) -> Value {
        json!({ "sessions": sessions, "cursor": "i:1" })
    }

    #[test]
    fn a_snapshot_becomes_the_whole_table() {
        let mirror = CoreSessions::new();

        assert!(mirror.apply_snapshot(
            1,
            "i",
            &snapshot(vec![session("a", 3001), session("b", 3002)])
        ));

        assert_eq!(mirror.loaded_model_ids(), vec!["a", "b"]);
        assert_eq!(mirror.find("a").unwrap().port, 3001);
        assert_eq!(
            mirror.find("a").unwrap().base_url(),
            "http://127.0.0.1:3001"
        );
        assert_eq!(mirror.generation(), Some(1));
    }

    #[test]
    fn a_later_snapshot_replaces_rather_than_merges() {
        // A model the core no longer has must disappear, not linger because the new snapshot did
        // not mention it.
        let mirror = CoreSessions::new();
        mirror.apply_snapshot(
            1,
            "i",
            &snapshot(vec![session("a", 3001), session("b", 3002)]),
        );

        mirror.apply_snapshot(2, "i2", &snapshot(vec![session("b", 3999)]));

        assert_eq!(mirror.loaded_model_ids(), vec!["b"]);
        assert_eq!(mirror.find("b").unwrap().port, 3999);
    }

    #[test]
    fn a_snapshot_from_a_generation_we_left_behind_is_ignored() {
        let mirror = CoreSessions::new();
        mirror.apply_snapshot(5, "i5", &snapshot(vec![session("new", 4000)]));

        assert!(!mirror.apply_snapshot(4, "i4", &snapshot(vec![session("old", 3000)])));

        assert_eq!(mirror.loaded_model_ids(), vec!["new"]);
    }

    #[test]
    fn a_started_session_is_added_and_a_dead_one_removed() {
        let mirror = CoreSessions::new();
        mirror.apply_snapshot(1, "i", &snapshot(vec![]));

        assert!(mirror.apply_event(1, "session:started", &session("a", 3001)));
        assert_eq!(mirror.find("a").unwrap().port, 3001);

        assert!(mirror.apply_event(
            1,
            "session:died",
            &json!({ "model_id": "a", "pid": 100, "provider": "llamacpp-upstream" })
        ));
        assert_eq!(mirror.find("a"), None);
    }

    #[test]
    fn an_unloaded_session_is_removed_too() {
        let mirror = CoreSessions::new();
        mirror.apply_snapshot(1, "i", &snapshot(vec![session("a", 3001)]));

        mirror.apply_event(
            1,
            "session:unloaded",
            &json!({ "model_id": "a", "pid": 100 }),
        );

        assert!(mirror.is_empty());
    }

    #[test]
    fn a_reload_replaces_the_port_rather_than_keeping_both() {
        // What an auto-increase-ctx looks like from here: same model, new process, new port.
        let mirror = CoreSessions::new();
        mirror.apply_snapshot(1, "i", &snapshot(vec![session("a", 3001)]));

        mirror.apply_event(1, "session:started", &session("a", 3777));

        assert_eq!(mirror.list().len(), 1);
        assert_eq!(mirror.find("a").unwrap().port, 3777);
    }

    #[test]
    fn an_event_applies_to_the_generation_the_mirror_holds() {
        let mirror = CoreSessions::new();
        mirror.apply_snapshot(9, "i", &snapshot(vec![]));

        assert!(mirror.apply_current_event("session:started", &session("a", 3001)));
        assert_eq!(mirror.find("a").unwrap().port, 3001);
    }

    #[test]
    fn an_event_with_nothing_attached_is_dropped_rather_than_creating_a_table() {
        let mirror = CoreSessions::new();

        assert!(!mirror.apply_current_event("session:started", &session("ghost", 9999)));

        assert!(mirror.is_empty());
        assert_eq!(mirror.generation(), None);
    }

    #[test]
    fn events_for_another_generation_are_dropped() {
        // The core died and a new one took over; an event still in flight from the old stream must
        // not add a port that belongs to a dead process.
        let mirror = CoreSessions::new();
        mirror.apply_snapshot(2, "i2", &snapshot(vec![]));

        assert!(!mirror.apply_event(1, "session:started", &session("ghost", 9999)));

        assert!(mirror.is_empty());
    }

    #[test]
    fn invalidating_empties_the_table_so_nothing_hands_out_a_dead_port() {
        let mirror = CoreSessions::new();
        mirror.apply_snapshot(3, "i", &snapshot(vec![session("a", 3001)]));

        assert!(mirror.invalidate(3));

        assert_eq!(mirror.find("a"), None);
        assert_eq!(mirror.generation(), None);
        assert_eq!(mirror.instance_id(), None);
    }

    #[test]
    fn invalidating_an_older_generation_leaves_the_current_table_alone() {
        let mirror = CoreSessions::new();
        mirror.apply_snapshot(3, "i", &snapshot(vec![session("a", 3001)]));

        assert!(!mirror.invalidate(2));

        assert!(mirror.find("a").is_some());
    }

    #[test]
    fn one_unreadable_entry_does_not_cost_the_rest_of_the_table() {
        let mirror = CoreSessions::new();

        mirror.apply_snapshot(
            1,
            "i",
            &snapshot(vec![
                session("a", 3001),
                json!({ "nonsense": true }),
                session("b", 3002),
            ]),
        );

        assert_eq!(mirror.loaded_model_ids(), vec!["a", "b"]);
    }

    #[test]
    fn a_snapshot_with_no_sessions_field_is_an_empty_table_not_a_panic() {
        let mirror = CoreSessions::new();

        assert!(mirror.apply_snapshot(1, "i", &json!({ "cursor": "i:0" })));

        assert!(mirror.is_empty());
    }

    #[test]
    fn a_dot_and_an_underscore_name_the_same_model() {
        // The proxy has always matched this way, because clients and filesystems swap the two.
        // A core-owned session must answer the same requests a plugin-owned one did.
        let mirror = CoreSessions::new();
        mirror.apply_snapshot(1, "i", &snapshot(vec![session("Qwen3.5-9B", 3001)]));

        assert_eq!(mirror.find("Qwen3_5-9B").unwrap().port, 3001);
        assert_eq!(mirror.find("Qwen3.5-9B").unwrap().port, 3001);
        assert_eq!(
            mirror.find("Qwen3-9B"),
            None,
            "a different name is still a different model"
        );
    }

    #[test]
    fn a_session_is_found_by_provider_only_when_the_provider_matches() {
        let mirror = CoreSessions::new();
        let mut mlx = session("m", 3100);
        mlx["provider"] = json!("mlx");
        mirror.apply_snapshot(1, "i", &snapshot(vec![session("a", 3001), mlx]));

        assert!(mirror.find_by_provider("llamacpp-upstream", "a").is_some());
        assert!(mirror.find_by_provider("mlx", "a").is_none());
        assert!(mirror.find_by_provider("mlx", "m").is_some());
    }

    #[test]
    fn the_preferred_embedding_model_wins_but_any_will_do() {
        let mirror = CoreSessions::new();
        let mut preferred = session("sentence-transformer-mini", 3200);
        preferred["is_embedding"] = json!(true);
        let mut other = session("bge", 3201);
        other["is_embedding"] = json!(true);
        mirror.apply_snapshot(1, "i", &snapshot(vec![other.clone(), preferred.clone()]));

        assert_eq!(
            mirror
                .find_embedding("sentence-transformer-mini")
                .unwrap()
                .port,
            3200
        );

        mirror.apply_snapshot(2, "i", &snapshot(vec![other]));
        assert_eq!(
            mirror
                .find_embedding("sentence-transformer-mini")
                .unwrap()
                .port,
            3201
        );

        mirror.apply_snapshot(3, "i", &snapshot(vec![session("text-only", 3300)]));
        assert_eq!(
            mirror.find_embedding("sentence-transformer-mini"),
            None,
            "a text model cannot embed"
        );
    }

    #[test]
    fn a_session_without_a_provider_is_assumed_to_be_the_one_the_core_owns_first() {
        // Older cores did not stamp the provider onto a session; the runtime that moved first is the
        // only one it could have been.
        let mirror = CoreSessions::new();
        let mut bare = session("a", 3001);
        bare.as_object_mut().unwrap().remove("provider");
        mirror.apply_snapshot(1, "i", &snapshot(vec![bare]));

        assert_eq!(mirror.find("a").unwrap().provider, "llamacpp-upstream");
    }
}
