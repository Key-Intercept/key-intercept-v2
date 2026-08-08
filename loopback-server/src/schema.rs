use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub rules_end: String,
    pub gag_end: String,
    pub pet_end: String,
    pub pet_amount: f64,
    pub pet_type: i64,
    pub bimbo_end: String,
    pub horny_end: String,
    pub bimbo_word_length: i64,
    pub drone_end: String,
    pub uwu_end: String,
    pub censored_end: String,
    pub censored_replacement: String,
    pub debug: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub rule_regex: String,
    pub rule_replacement: String,
    pub regex_normalize: bool,
    pub enabled: bool,
    pub chance_to_apply: f64,
    pub order: i64,
    pub group_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleGroup {
    pub id: i64,
    #[serde(default = "default_group_timeout_end")]
    pub timeout_end: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub disabled_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WhitelistItem {
    pub server_name: String,
    pub discord_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeFilterMode {
    Whitelist,
    Blacklist,
}

impl Default for ScopeFilterMode {
    fn default() -> Self {
        Self::Whitelist
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DroneConfig {
    pub drone_health: i64,
    pub speech_header: String,
    pub speech_footer: String,
    pub action_header: String,
    pub action_footer: String,
    pub whisper_header: String,
    pub whisper_footer: String,
    pub loud_header: String,
    pub loud_footer: String,
    pub drone_term: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalConfig {
    pub config: Config,
    pub rules: Vec<Rule>,
    pub rules_groups: Vec<RuleGroup>,
    pub whitelist: Vec<WhitelistItem>,
    pub blacklist: Vec<WhitelistItem>,
    #[serde(default)]
    pub filter_mode: ScopeFilterMode,
    pub pet_words: Vec<String>,
    pub censored_words: Vec<String>,
    pub drone_config: DroneConfig,
}

impl Default for LocalConfig {
    fn default() -> Self {
        Self {
            config: Config {
                rules_end: "9999-12-31T23:59:59.000Z".to_string(),
                gag_end: "1970-01-01T00:00:00.000Z".to_string(),
                pet_end: "1970-01-01T00:00:00.000Z".to_string(),
                pet_amount: 0.0,
                pet_type: 0,
                bimbo_end: "1970-01-01T00:00:00.000Z".to_string(),
                horny_end: "1970-01-01T00:00:00.000Z".to_string(),
                bimbo_word_length: 12,
                drone_end: "1970-01-01T00:00:00.000Z".to_string(),
                uwu_end: "1970-01-01T00:00:00.000Z".to_string(),
                censored_end: "1970-01-01T00:00:00.000Z".to_string(),
                censored_replacement: "*".to_string(),
                debug: false,
            },
            rules: vec![],
            rules_groups: vec![],
            whitelist: vec![],
            blacklist: vec![],
            filter_mode: ScopeFilterMode::Whitelist,
            pet_words: vec![],
            censored_words: vec![],
            drone_config: DroneConfig {
                drone_health: 100,
                speech_header: "Acknowledged".to_string(),
                speech_footer: "Compliance complete".to_string(),
                action_header: "ACTION".to_string(),
                action_footer: "ACTION COMPLETE".to_string(),
                whisper_header: "WHISPER".to_string(),
                whisper_footer: "WHISPER COMPLETE".to_string(),
                loud_header: "LOUD".to_string(),
                loud_footer: "LOUD COMPLETE".to_string(),
                drone_term: "Drone".to_string(),
            },
        }
    }
}

impl LocalConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !(0.0..=1.0).contains(&self.config.pet_amount) {
            return Err("config.pet_amount must be between 0 and 1".to_string());
        }
        if self.config.bimbo_word_length < 1 {
            return Err("config.bimbo_word_length must be at least 1".to_string());
        }
        if self.config.censored_replacement.is_empty() {
            return Err("config.censored_replacement must not be empty".to_string());
        }
        if !(0..=100).contains(&self.drone_config.drone_health) {
            return Err("drone_config.drone_health must be between 0 and 100".to_string());
        }

        for rule in &self.rules {
            if !(0.0..=1.0).contains(&rule.chance_to_apply) {
                return Err("rules[*].chance_to_apply must be between 0 and 1".to_string());
            }
        }

        for group in &self.rules_groups {
            if group.id < 1 {
                return Err("rules_groups[*].id must be at least 1".to_string());
            }
            if group.order < 0 {
                return Err("rules_groups[*].order must be 0 or greater".to_string());
            }
        }

        for item in &self.whitelist {
            if !item.discord_id.is_empty() && !is_discord_id(&item.discord_id) {
                return Err("whitelist[*].discord_id must be numeric".to_string());
            }
        }
        for item in &self.blacklist {
            if !item.discord_id.is_empty() && !is_discord_id(&item.discord_id) {
                return Err("blacklist[*].discord_id must be numeric".to_string());
            }
        }

        Ok(())
    }
}

pub fn is_discord_id(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())
}

fn default_group_timeout_end() -> String {
    "9999-12-31T23:59:59.000Z".to_string()
}

fn default_true() -> bool {
    true
}
