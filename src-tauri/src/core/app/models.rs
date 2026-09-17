use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutostartPreference {
    PendingDefaultOn,
    Unmanaged,
    Enabled,
    Disabled,
}

fn existing_install_autostart_preference() -> AutostartPreference {
    AutostartPreference::Unmanaged
}

/// Which of the app's responsibilities `atomic-chat-core` currently owns.
///
/// This is the rollback switch for the core migration (PLAN.md §4, "Откат: флаг
/// `off` по умолчанию"): with everything `Off` the app behaves exactly as it did
/// before the core existed, and no core process is started. It lives in the
/// app's own `settings.json` rather than in the data folder because it has to be
/// readable before — and independently of — the data folder the core would own.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AtomicCoreFlags {
    /// Attach to (or start) a core at all. The transport switch: everything else
    /// needs it, and by itself it changes no user-visible behaviour.
    #[serde(default)]
    pub attach: bool,
    /// Which local runtime the core owns. `None` means the app's own llama.cpp
    /// plugin keeps every session.
    #[serde(default)]
    pub runtime: Option<CoreRuntimeOwner>,
    /// Who serves the public API on :1337. `None` means the app's Rust server.
    #[serde(default)]
    pub server: Option<CoreServerOwner>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CoreRuntimeOwner {
    LlamacppUpstream,
    /// Every local runtime — llama.cpp upstream, TurboQuant, MLX and Foundation
    /// Models (PLAN.md §4, stage 5). There is deliberately no flag per provider:
    /// the rollback is one coordinated handover back to `llamacpp-upstream` or off.
    All,
}

impl CoreRuntimeOwner {
    /// The providers whose sessions the core owns under this flag.
    pub fn providers(self) -> &'static [&'static str] {
        match self {
            CoreRuntimeOwner::LlamacppUpstream => &["llamacpp-upstream"],
            CoreRuntimeOwner::All => &["llamacpp-upstream", "llamacpp", "mlx", "foundation-models"],
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoreServerOwner {
    Core,
    /// The explicit rollback: the app's own proxy serves, as with no flag at all.
    Legacy,
}

impl AtomicCoreFlags {
    /// A core is needed as soon as anything is delegated to it — delegating a
    /// runtime without the transport would silently do nothing.
    /// Whether the core serves the public API. `legacy` and no flag both mean the app does.
    pub fn core_serves(&self) -> bool {
        self.server == Some(CoreServerOwner::Core)
    }

    pub fn needs_core(&self) -> bool {
        self.attach || self.runtime.is_some() || self.core_serves()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AppConfiguration {
    pub data_folder: String,
    #[serde(default = "existing_install_autostart_preference")]
    pub autostart_preference: AutostartPreference,
    /// Absent in every configuration written before the core existed, which
    /// deserializes to "the core owns nothing" — the pre-migration behaviour.
    #[serde(default)]
    pub atomic_core: AtomicCoreFlags,
    // Add other fields as needed
}

impl AppConfiguration {
    pub fn default() -> Self {
        Self {
            data_folder: String::from("./data"), // Set a default value for the data_folder
            autostart_preference: AutostartPreference::Unmanaged,
            atomic_core: AtomicCoreFlags::default(),
            // Add other fields with default values as needed
        }
    }

    /// A freshly created configuration. New installs no longer claim a Login
    /// Item / startup entry: the app has to open fast and cold, and autostart
    /// is opt-in from Settings. `PendingDefaultOn` is kept as a variant so
    /// configurations written by older builds still deserialize and complete
    /// the contract they were created under.
    pub fn new_install() -> Self {
        Self {
            autostart_preference: AutostartPreference::Unmanaged,
            ..Self::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AppConfiguration, AtomicCoreFlags, AutostartPreference, CoreRuntimeOwner, CoreServerOwner,
    };

    #[test]
    fn fallback_config_does_not_enable_autostart() {
        assert_eq!(
            AppConfiguration::default().autostart_preference,
            AutostartPreference::Unmanaged
        );
    }

    #[test]
    fn new_install_does_not_enable_autostart() {
        assert_eq!(
            AppConfiguration::new_install().autostart_preference,
            AutostartPreference::Unmanaged
        );
    }

    #[test]
    fn existing_config_without_preference_remains_unmanaged() {
        let config: AppConfiguration = serde_json::from_str(r#"{"data_folder":"./data"}"#).unwrap();

        assert_eq!(config.autostart_preference, AutostartPreference::Unmanaged);
    }

    #[test]
    fn a_configuration_written_before_the_core_existed_delegates_nothing() {
        let config: AppConfiguration = serde_json::from_str(r#"{"data_folder":"./data"}"#).unwrap();

        assert!(!config.atomic_core.needs_core());
        assert_eq!(config.atomic_core, AtomicCoreFlags::default());
    }

    #[test]
    fn a_partial_flags_object_keeps_the_fields_it_does_not_mention_off() {
        let config: AppConfiguration =
            serde_json::from_str(r#"{"data_folder":"./d","atomic_core":{"attach":true}}"#).unwrap();

        assert!(config.atomic_core.attach);
        assert_eq!(config.atomic_core.runtime, None);
        assert_eq!(config.atomic_core.server, None);
    }

    #[test]
    fn delegating_a_runtime_implies_a_core_even_without_the_transport_flag() {
        // Otherwise a half-set configuration would leave the runtime pointed at a
        // core that was never started, and loads would fail with no owner at all.
        let flags = AtomicCoreFlags {
            attach: false,
            runtime: Some(CoreRuntimeOwner::LlamacppUpstream),
            server: None,
        };

        assert!(flags.needs_core());
    }

    #[test]
    fn flags_round_trip_through_the_names_the_webview_uses() {
        let flags = AtomicCoreFlags {
            attach: true,
            runtime: Some(CoreRuntimeOwner::LlamacppUpstream),
            server: Some(CoreServerOwner::Core),
        };
        let json = serde_json::to_string(&flags).unwrap();

        assert_eq!(
            json,
            r#"{"attach":true,"runtime":"llamacpp-upstream","server":"core"}"#
        );
        assert_eq!(
            serde_json::from_str::<AtomicCoreFlags>(&json).unwrap(),
            flags
        );
    }

    #[test]
    fn handing_every_runtime_over_is_one_flag_value_covering_four_providers() {
        let flags: AtomicCoreFlags = serde_json::from_str(r#"{"runtime":"all"}"#).unwrap();

        assert_eq!(flags.runtime, Some(CoreRuntimeOwner::All));
        assert!(flags.needs_core());
        assert_eq!(
            CoreRuntimeOwner::All.providers(),
            &["llamacpp-upstream", "llamacpp", "mlx", "foundation-models"]
        );
        assert_eq!(CoreRuntimeOwner::LlamacppUpstream.providers(), &["llamacpp-upstream"]);
        assert_eq!(serde_json::to_string(&CoreRuntimeOwner::All).unwrap(), r#""all""#);
    }

    #[test]
    fn the_legacy_server_flag_is_the_rollback_and_needs_no_core() {
        let flags: AtomicCoreFlags = serde_json::from_str(r#"{"server":"legacy"}"#).unwrap();

        assert_eq!(flags.server, Some(CoreServerOwner::Legacy));
        assert!(!flags.core_serves());
        assert!(!flags.needs_core());
        assert!(AtomicCoreFlags { server: Some(CoreServerOwner::Core), ..flags }.core_serves());
    }
}
