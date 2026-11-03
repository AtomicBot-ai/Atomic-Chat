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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AppConfiguration {
    pub data_folder: String,
    #[serde(default = "existing_install_autostart_preference")]
    pub autostart_preference: AutostartPreference,
    /// The install's analytics id: the PostHog distinct id, also the Sentry
    /// user. The web app stores PostHog's id here on its first launch and
    /// identifies with it afterwards, so the person outlives cleared webview
    /// storage. Absent from configurations written before it existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distinct_id: Option<String>,
    // Add other fields as needed
}

impl AppConfiguration {
    pub fn default() -> Self {
        Self {
            data_folder: String::from("./data"), // Set a default value for the data_folder
            autostart_preference: AutostartPreference::Unmanaged,
            distinct_id: None,
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
    use super::{AppConfiguration, AutostartPreference};

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
    fn a_configuration_carrying_the_retired_core_flags_still_loads() {
        // Stages 3–5 wrote `atomic_core` into settings.json. The core now owns every desktop runtime
        // unconditionally; the old object is ignored rather than refused, so an upgraded install
        // keeps its data folder and autostart preference.
        let config: AppConfiguration = serde_json::from_str(
            r#"{"data_folder":"./d","atomic_core":{"attach":true,"runtime":"all","server":"core"}}"#,
        )
        .unwrap();

        assert_eq!(config.data_folder, "./d");
    }

    #[test]
    fn the_distinct_id_round_trips() {
        let config = AppConfiguration {
            distinct_id: Some("0192f3a4-5b6c-7d8e-9f01-23456789abcd".to_string()),
            ..AppConfiguration::default()
        };

        let written = serde_json::to_string(&config).unwrap();
        let read: AppConfiguration = serde_json::from_str(&written).unwrap();

        assert_eq!(
            read.distinct_id.as_deref(),
            Some("0192f3a4-5b6c-7d8e-9f01-23456789abcd")
        );
    }

    #[test]
    fn a_configuration_without_a_distinct_id_still_loads_and_writes_none() {
        // Every settings.json written before the field existed lacks it.
        let config: AppConfiguration =
            serde_json::from_str(r#"{"data_folder":"./d","autostart_preference":"disabled"}"#)
                .unwrap();

        assert_eq!(config.distinct_id, None);
        assert_eq!(config.autostart_preference, AutostartPreference::Disabled);
        let written = serde_json::to_string(&config).unwrap();
        assert!(!written.contains("distinct_id"));
    }
}
