use agent_of_empires::session::config::{
    profile_config::resolve_config_or_warn,
    settings_schema::{validate_patch, Scope},
    update_config, Config,
};
use serde_json::json;
use serial_test::serial;

#[test]
#[serial]
fn hibernation_protection_is_global_validated_persisted_and_hot_reloaded() {
    let temp = tempfile::tempdir().unwrap();
    let _env = crate::common::set_temp_home(temp.path());
    let role = "0123456789abcdef";
    let successor = "fedcba9876543210";
    for (value, accepted) in [
        (json!([]), true),
        (json!([role, successor]), true),
        (json!(null), true),
        (json!(role), false),
        (json!([role, 42]), false),
        (json!([false]), false),
        (json!({}), false),
    ] {
        let patch = json!({"session": {"hibernate_protected_sessions": value}});
        assert_eq!(
            validate_patch(&patch, Scope::Global, false).is_ok(),
            accepted,
            "{value}"
        );
        assert!(
            validate_patch(&patch, Scope::Profile, false).is_err(),
            "profile override: {value}"
        );
    }
    update_config(|config| {
        *config = toml::from_str(&format!(
            "[session]\nhibernate_protected_sessions = [\"{role}\"]\n"
        ))
        .unwrap();
    })
    .unwrap();
    // A later writer must retain the protection it did not edit.
    update_config(|config| config.session.confirm_delete = false).unwrap();
    let profile_dir = agent_of_empires::session::get_profile_dir("roles").unwrap();
    // Even a hand-edited profile cannot shadow the global control-plane roles.
    std::fs::write(
        profile_dir.join("config.toml"),
        "[session]\nhibernate_protected_sessions = []\n",
    )
    .unwrap();
    let resolved = resolve_config_or_warn("roles");
    assert_eq!(
        serde_json::to_value(&resolved).unwrap()["session"]["hibernate_protected_sessions"],
        json!([role])
    );
    assert!(!resolved.session.confirm_delete);
    update_config(|config| {
        let mut value = serde_json::to_value(&*config).unwrap();
        value["session"]["hibernate_protected_sessions"] = json!([successor]);
        *config = serde_json::from_value::<Config>(value).unwrap();
    })
    .unwrap();
    let resolved = resolve_config_or_warn("roles");
    assert_eq!(
        serde_json::to_value(resolved).unwrap()["session"]["hibernate_protected_sessions"],
        json!([successor])
    );
}
