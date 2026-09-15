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
    /// The folder models are saved to and read from, when the user chose one
    /// on the Models page. Absent means `<data_folder>/llamacpp/models`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models_folder: Option<String>,
    // Add other fields as needed
}

impl Default for AppConfiguration {
    fn default() -> Self {
        Self {
            data_folder: String::from("./data"), // Set a default value for the data_folder
            autostart_preference: AutostartPreference::Unmanaged,
            models_folder: None,
            // Add other fields with default values as needed
        }
    }
}

impl AppConfiguration {
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
}
