//! Connect-only native Codex delivery. Never falls back to terminal input.
use super::Instance;
use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;

const HELPER: &str = include_str!("../../contrib/codex-queue-send.cjs");

pub(crate) fn is_native_codex(instance: &Instance) -> bool {
    !instance.is_structured()
        && (instance
            .resolved_agent()
            .is_some_and(|agent| agent.name == "codex")
            || super::resolved_agent_for(
                &instance.effective_profile(),
                &instance.tool,
                &instance.detect_as,
            )
            .is_some_and(|agent| agent.name == "codex"))
}

pub(crate) fn ensure_legacy_wake_safe(instance: &Instance, wake: &str) -> Result<()> {
    if !wake.is_empty() && is_native_codex(instance) {
        bail!("Native Codex restart wake is held without an original delivery ID; restart was not attempted and configured wake text is preserved");
    }
    Ok(())
}

fn packet(instance: &Instance, text: &str, delivery_id: Option<&str>) -> Result<serde_json::Value> {
    instance.ensure_startable()?;
    let delivery_id = delivery_id.filter(|id| !id.trim().is_empty()).context(
        "Native Codex delivery requires the original stable delivery_id; no terminal fallback",
    )?;
    if delivery_id.len() > 256 || text.trim().is_empty() {
        bail!("Native Codex delivery requires a nonempty message and delivery_id of at most 256 bytes");
    }
    if instance.tool != "codex" || instance.is_sandboxed() {
        bail!("Native Codex alias or sandbox store mapping is unsupported; delivery held");
    }
    let thread = instance
        .agent_session_id
        .as_deref()
        .context("Native Codex thread is not recorded; delivery held")?;
    uuid::Uuid::parse_str(thread).context("Invalid recorded native Codex thread; delivery held")?;
    Ok(
        serde_json::json!({"sessionId": instance.id, "threadId": thread,
        "deliveryId": delivery_id, "text": text}),
    )
}

pub(crate) async fn send(
    instance: &Instance,
    text: &str,
    delivery_id: Option<&str>,
) -> Result<&'static str> {
    let packet = packet(instance, text, delivery_id)?;
    let store = instance
        .declared_agent_config_dir_for("codex")
        .context("Native Codex store must be explicitly declared; delivery held")?;
    let sessions =
        super::get_profile_dir_path(&instance.effective_profile())?.join("sessions.json");
    let state = match std::env::var_os("AOE_CODEX_QUEUE_STATE_DIR") {
        Some(path) => std::path::PathBuf::from(path),
        None => super::get_app_dir()?.join("native-deliveries"),
    };
    let mut command = tokio::process::Command::new("node");
    if let Some(helper) = std::env::var_os("AOE_CODEX_QUEUE_HELPER") {
        command.arg(helper);
    } else {
        command.arg("-e").arg(format!("const AOE_EMBEDDED_SOURCE={};\n{}\nmodule.exports.main(process.argv.slice(1)).catch(e=>{{console.error(e.message);process.exitCode=1;}});", serde_json::to_string(HELPER)?, HELPER.split_once('\n').map_or(HELPER, |(_, body)| body))).arg("--");
    }
    command
        .arg("--packet")
        .arg("-")
        .arg("--store")
        .arg(store)
        .arg("--state-dir")
        .arg(state)
        .arg("--sessions-file")
        .arg(sessions)
        .arg("--ws-module")
        .arg(std::env::var_os("AOE_CODEX_WS_MODULE").unwrap_or_else(|| "ws".into()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .context("Native Codex queue helper unavailable; delivery held")?;
    child
        .stdin
        .take()
        .context("Queue helper stdin unavailable")?
        .write_all(&serde_json::to_vec(&packet)?)
        .await?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(60), child.wait_with_output())
        .await
        .context(
            "Native Codex delivery uncertain after timeout; retain the original delivery ID",
        )??;
    if !output.status.success() {
        bail!(
            "Native Codex delivery held: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let receipt: serde_json::Value = serde_json::from_slice(&output.stdout)
        .context("Native Codex queue receipt invalid; retain the original delivery ID")?;
    let text_hash: String = Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if receipt["deliveryId"] != packet["deliveryId"]
        || receipt["textSha256"].as_str() != Some(text_hash.as_str())
    {
        bail!("Native Codex queue acceptance unconfirmed; retain the original delivery ID");
    }
    match receipt["disposition"].as_str() {
        Some("queued") => Ok("queued"),
        Some("recorded") => Ok("recorded"),
        _ => bail!("Native Codex queue acceptance unconfirmed; retain the original delivery ID"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_automated_restart_wake_must_not_paste_into_a_human_codex_draft() {
        let mut instance = Instance::new("synthetic", "/tmp/synthetic");
        instance.tool = "codex".into();
        assert!(ensure_legacy_wake_safe(&instance, "configured wake").is_err());
        assert!(ensure_legacy_wake_safe(&instance, "").is_ok());
        instance.tool = "claude".into();
        assert!(ensure_legacy_wake_safe(&instance, "configured wake").is_ok());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[serial_test::serial]
    async fn automated_native_delivery_keeps_identity_without_nested_lifecycle_locks() {
        let temp = tempfile::tempdir().unwrap();
        let _app = crate::session::test_support::isolate_app_dir_at(temp.path());
        let profile = "synthetic-native-queue";
        let store = temp.path().join("store");
        let journal = temp.path().join("shared-journal");
        let helper = temp.path().join("fixture.cjs");
        let config =
            crate::session::config::profile_config::get_profile_config_path(profile).unwrap();
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(
            config,
            format!(
                "[session.agent_config_dir]\ncodex = {:?}\n",
                store.to_str().unwrap()
            ),
        )
        .unwrap();
        std::fs::write(&helper, r#"
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2), value=flag=>args[args.indexOf(flag)+1];
assert.equal(value('--packet'),'-');
assert.equal(value('--store'),path.join(__dirname,'store'));
assert.equal(value('--state-dir'),path.join(__dirname,'shared-journal'));
assert.equal(path.basename(value('--sessions-file')),'sessions.json');
const packet=JSON.parse(fs.readFileSync(0,'utf8'));
assert.equal(packet.deliveryId,'source:123');
assert.equal(packet.threadId,'11111111-1111-4111-8111-111111111111');
assert.equal(require('node:child_process').spawnSync('flock',['-n',path.join(path.dirname(value('--sessions-file')),`.instance-lifecycle-${packet.sessionId}.lock`),'true']).status,0,'caller must delegate the single lifecycle guard to the canonical helper');
console.log(JSON.stringify({deliveryId:packet.text==='invalid-receipt'?'wrong-source':packet.deliveryId,
  textSha256:require('node:crypto').createHash('sha256').update(packet.text).digest('hex'),
  disposition:packet.text==='recorded'?'recorded':'queued'}));
"#).unwrap();
        let _env = crate::session::test_support::EnvGuard::set(&[
            ("AOE_CODEX_QUEUE_HELPER", helper.as_os_str()),
            ("AOE_CODEX_QUEUE_STATE_DIR", journal.as_os_str()),
        ]);
        let mut instance = Instance::new("synthetic", "/tmp/synthetic");
        instance.tool = "codex".into();
        instance.source_profile = profile.into();
        instance.agent_session_id = Some("11111111-1111-4111-8111-111111111111".into());
        let storage = super::super::Storage::new_unwatched(profile).unwrap();
        storage
            .update(|rows, _| {
                rows.push(instance.clone());
                Ok(())
            })
            .unwrap();
        assert_eq!(
            send(&instance, "queued", Some("source:123")).await.unwrap(),
            "queued"
        );
        assert_eq!(
            send(&instance, "recorded", Some("source:123"))
                .await
                .unwrap(),
            "recorded"
        );
        assert!(send(&instance, "invalid-receipt", Some("source:123"))
            .await
            .is_err());
    }

    #[test]
    fn automated_codex_messages_cannot_submit_a_human_draft_without_a_stable_delivery_id() {
        let mut instance = Instance::new("synthetic", "/tmp/synthetic");
        instance.tool = "codex".into();
        instance.agent_session_id = Some("11111111-1111-4111-8111-111111111111".into());
        for id in [None, Some(""), Some(" ")] {
            assert!(packet(&instance, "distinct instruction", id).is_err());
        }
        let first = packet(&instance, "distinct instruction", Some("source:123")).unwrap();
        assert_eq!(
            first,
            packet(&instance, "distinct instruction", Some("source:123")).unwrap()
        );
        assert_eq!(first["deliveryId"], "source:123");
        assert!(packet(&instance, " ", Some("source:123")).is_err());
        instance.agent_session_id = None;
        assert!(packet(&instance, "distinct instruction", Some("source:123")).is_err());
        instance.tool = "codex-alias".into();
        assert!(packet(&instance, "distinct instruction", Some("source:123")).is_err());
    }
}
