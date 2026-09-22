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
    /// `None` when the backend is not a process on this machine: a container has no host pid, and
    /// the one inside it belongs to another kernel's numbering.
    #[serde(default)]
    pub pid: Option<i32>,
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
    /// `native` or `container`. Absent on every session a previous core described, and native.
    #[serde(default)]
    pub execution: Option<String>,
    /// Changes each time the model is loaded again.
    #[serde(default)]
    pub generation: Option<String>,
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
    /// Keyed by `(provider, model_id)`. Two engines can hold a model with the same name — the same
    /// checkpoint under llama.cpp and under a managed runtime is the ordinary case — and keying by
    /// the name alone would let whichever loaded second silently replace the first in this table,
    /// sending the app's requests to the wrong port.
    by_session: HashMap<(String, String), CoreSession>,
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
        mirror.by_session = parse_sessions(snapshot)
            .into_iter()
            .map(|session| ((session.provider.clone(), session.model_id.clone()), session))
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
                    let key = (session.provider.clone(), session.model_id.clone());
                    mirror.by_session.insert(key, session);
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
                match payload.get("provider").and_then(Value::as_str) {
                    Some(provider) => mirror
                        .by_session
                        .remove(&(provider.to_string(), model_id.to_string()))
                        .is_some(),
                    // A core old enough not to name the engine: drop every session with that name,
                    // because leaving one behind would point the app at a port that has gone.
                    None => {
                        let before = mirror.by_session.len();
                        mirror.by_session.retain(|(_, id), _| id != model_id);
                        mirror.by_session.len() != before
                    }
                }
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
        // A caller that names no engine gets an exact name before a fuzzy one, and among equals the
        // first engine in name order. Arbitrary, but the same answer every time: a lookup that
        // depended on hash order would send two identical requests to two different ports.
        let mut candidates: Vec<&CoreSession> = mirror
            .by_session
            .values()
            .filter(|s| s.model_id == model_id)
            .collect();
        if candidates.is_empty() {
            candidates = mirror
                .by_session
                .values()
                .filter(|s| model_ids_match(&s.model_id, model_id))
                .collect();
        }
        candidates.sort_by(|a, b| a.provider.cmp(&b.provider));
        candidates.first().map(|session| (*session).clone())
    }

    /// The session one engine holds. Exact on the engine; the model name matches as `find` does.
    pub fn find_by_provider(&self, provider: &str, model_id: &str) -> Option<CoreSession> {
        let mirror = self.inner.read().expect("core sessions");
        mirror
            .by_session
            .get(&(provider.to_string(), model_id.to_string()))
            .or_else(|| {
                mirror
                    .by_session
                    .values()
                    .find(|s| s.provider == provider && model_ids_match(&s.model_id, model_id))
            })
            .cloned()
    }

    /// An embedding session, preferring `preferred` when it is loaded.
    ///
    /// The app's RAG bridge asks for "something that can embed"; which model that is depends on
    /// what happens to be loaded.
    pub fn find_embedding(&self, preferred: &str) -> Option<CoreSession> {
        let mirror = self.inner.read().expect("core sessions");
        let mut embedding: Vec<&CoreSession> =
            mirror.by_session.values().filter(|s| s.is_embedding).collect();
        embedding.sort_by(|a, b| (&a.model_id, &a.provider).cmp(&(&b.model_id, &b.provider)));
        embedding
            .iter()
            .find(|s| s.model_id == preferred)
            .or_else(|| embedding.first())
            .map(|session| (*session).clone())
    }

    pub fn list(&self) -> Vec<CoreSession> {
        let mut sessions: Vec<CoreSession> = self
            .inner
            .read()
            .expect("core sessions")
            .by_session
            .values()
            .cloned()
            .collect();
        // Stable order: `/models` and the UI should not reshuffle between reads. The engine breaks
        // the tie, because two of them can hold the same model name.
        sessions.sort_by(|a, b| (&a.model_id, &a.provider).cmp(&(&b.model_id, &b.provider)));
        sessions
    }

    pub fn loaded_model_ids(&self) -> Vec<String> {
        self.list().into_iter().map(|s| s.model_id).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.inner
            .read()
            .expect("core sessions")
            .by_session
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

    /// The same model name under another engine, and served from another port.
    fn session_of(provider: &str, model_id: &str, port: i32) -> Value {
        let mut value = session(model_id, port);
        value["provider"] = json!(provider);
        value
    }

    /// What a managed runtime reports: no process on this machine, and a generation of its own.
    fn container_session(model_id: &str, port: i32) -> Value {
        json!({
            "pid": null,
            "port": port,
            "model_id": model_id,
            "model_path": format!("/artifacts/{model_id}"),
            "is_embedding": false,
            "api_key": "k",
            "provider": "tensorrt-llm",
            "execution": "container",
            "generation": "g7",
        })
    }

    fn snapshot(sessions: Vec<Value>) -> Value {
        json!({ "sessions": sessions, "cursor": "i:1" })
    }

    #[test]
    fn two_engines_holding_the_same_model_name_stay_separate() {
        let sessions = CoreSessions::new();
        assert!(sessions.apply_snapshot(
            1,
            "i",
            &snapshot(vec![
                session_of("llamacpp-upstream", "qwen3-4b", 3001),
                session_of("tensorrt-llm", "qwen3-4b", 3002),
            ]),
        ));

        // Keyed by the name alone, whichever loaded second would have replaced the first here and
        // the app would have sent llama.cpp's requests to the container's port.
        assert_eq!(sessions.list().len(), 2);
        assert_eq!(
            sessions
                .find_by_provider("llamacpp-upstream", "qwen3-4b")
                .map(|s| s.port),
            Some(3001)
        );
        assert_eq!(
            sessions
                .find_by_provider("tensorrt-llm", "qwen3-4b")
                .map(|s| s.port),
            Some(3002)
        );
    }

    #[test]
    fn unloading_one_engines_model_leaves_the_other_engines_alone() {
        let sessions = CoreSessions::new();
        sessions.apply_snapshot(
            1,
            "i",
            &snapshot(vec![
                session_of("llamacpp-upstream", "qwen3-4b", 3001),
                session_of("tensorrt-llm", "qwen3-4b", 3002),
            ]),
        );

        assert!(sessions.apply_event(
            1,
            "session:unloaded",
            &json!({ "provider": "tensorrt-llm", "model_id": "qwen3-4b", "pid": null }),
        ));

        assert_eq!(sessions.list().len(), 1);
        assert_eq!(sessions.list()[0].provider, "llamacpp-upstream");
    }

    #[test]
    fn an_unload_that_names_no_engine_clears_every_session_with_that_name() {
        let sessions = CoreSessions::new();
        sessions.apply_snapshot(
            1,
            "i",
            &snapshot(vec![
                session_of("llamacpp-upstream", "qwen3-4b", 3001),
                session_of("tensorrt-llm", "qwen3-4b", 3002),
            ]),
        );

        // A core old enough not to name the engine. Leaving one behind would point the app at a
        // port that has gone, so the whole name goes.
        assert!(sessions.apply_event(1, "session:died", &json!({ "model_id": "qwen3-4b" })));
        assert!(sessions.is_empty());
    }

    #[test]
    fn a_session_with_no_process_on_this_machine_is_carried_intact() {
        let sessions = CoreSessions::new();
        assert!(sessions.apply_snapshot(1, "i", &snapshot(vec![container_session("llama-3.1-8b", 3100)])));

        let found = sessions.find("llama-3.1-8b").expect("the session");
        assert_eq!(found.pid, None);
        assert_eq!(found.execution.as_deref(), Some("container"));
        assert_eq!(found.generation.as_deref(), Some("g7"));
        // What every caller actually needs is where it answers, and that is unchanged.
        assert_eq!(found.base_url(), "http://127.0.0.1:3100");
    }

    #[test]
    fn a_native_session_keeps_the_process_id_it_always_had() {
        let sessions = CoreSessions::new();
        sessions.apply_snapshot(1, "i", &snapshot(vec![session("qwen3-4b", 3001)]));
        let found = sessions.find("qwen3-4b").expect("the session");
        assert_eq!(found.pid, Some(100));
        // Absent means native: nothing a previous release wrote has to be rewritten.
        assert_eq!(found.execution, None);
    }

    #[test]
    fn a_lookup_without_an_engine_answers_the_same_way_every_time() {
        let sessions = CoreSessions::new();
        sessions.apply_snapshot(
            1,
            "i",
            &snapshot(vec![
                session_of("tensorrt-llm", "qwen3-4b", 3002),
                session_of("llamacpp-upstream", "qwen3-4b", 3001),
                session_of("mlx", "qwen3-4b", 3003),
            ]),
        );
        // Engine name order, not hash order: two identical requests must not reach two ports.
        for _ in 0..5 {
            assert_eq!(sessions.find("qwen3-4b").map(|s| s.provider), Some("llamacpp-upstream".into()));
        }
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
