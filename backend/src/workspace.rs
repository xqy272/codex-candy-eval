//! Host-backed drafts: management iframes have opaque origins and no Web Storage.
use crate::{history, jobs::BatchRequest, management::AppState};
use gateway_plugin_sdk::{
    ErrorCode, PluginFault,
    call::host::{StateGetRequest, StateGetResult, StatePutRequest, StatePutResult},
    client::HostClient,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Draft {
    effort: String,
    profile: String,
    repeats: usize,
    output_version: String,
    batch_id: String,
    focus: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    kind: String,
    model: String,
    key_id: String,
    selected: Vec<String>,
    focus: String,
    batch_id: String,
    drafts: BTreeMap<String, Draft>,
    pending: Option<BatchRequest>,
    effort: String,
    profile: String,
    repeats: usize,
    output_version: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Save {
    draft: Workspace,
    expected_version: Option<u64>,
}
fn text(s: &str) -> bool {
    s.len() <= 256 && !s.chars().any(char::is_control)
}
fn kind(s: &str) -> bool {
    matches!(s, "candy" | "fingerprint" | "pelican")
}
fn fields(effort: &str, profile: &str, repeats: usize, output: &str) -> bool {
    matches!(
        effort,
        "" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    ) && matches!(profile, "simple-v1" | "codex-context-v1")
        && [1, 3, 5].contains(&repeats)
        && matches!(output, "svg-v1" | "legacy-animation-v1")
}
impl Workspace {
    fn valid(&self) -> bool {
        kind(&self.kind)
            && [&self.model, &self.key_id, &self.focus, &self.batch_id]
                .iter()
                .all(|v| text(v))
            && self.selected.len() <= 128
            && self.selected.iter().all(|s| text(s))
            && fields(
                &self.effort,
                &self.profile,
                self.repeats,
                &self.output_version,
            )
            && self.drafts.len() <= 3
            && self.drafts.iter().all(|(k, d)| {
                kind(k)
                    && text(&d.batch_id)
                    && text(&d.focus)
                    && fields(&d.effort, &d.profile, d.repeats, &d.output_version)
            })
            && self.pending.as_ref().is_none_or(|p| {
                kind(&p.kind)
                    && text(&p.id)
                    && text(&p.model)
                    && text(&p.client_key_id)
                    && p.account_ids.len() <= 16
                    && p.account_ids.iter().all(|a| text(a))
                    && fields(&p.effort, &p.profile, p.repeats, &p.output_version)
                    && (1..=4).contains(&p.concurrency)
            })
    }
}
async fn read(host: &HostClient) -> Result<StateGetResult, PluginFault> {
    let (v, _) = history::callback(
        host,
        "host.state.get",
        StateGetRequest {
            namespace: "batches".into(),
            key: "workspace".into(),
        },
        vec![],
    )
    .await?;
    Ok(v)
}
pub async fn get(host: &HostClient) -> Result<Value, PluginFault> {
    let r = read(host).await?.record;
    Ok(match r {
        Some(r) => json!({"draft":r.value,"version":r.version}),
        None => json!({"draft":null,"version":null}),
    })
}
pub async fn save(state: &AppState, host: &HostClient, req: Save) -> Result<Value, PluginFault> {
    if !req.draft.valid() {
        return Err(PluginFault::new(
            ErrorCode::InvalidInput,
            "页面草稿参数无效",
        ));
    }
    let _lock = state.admission.lock().await;
    let version = read(host).await?.record.map(|r| r.version);
    if version != req.expected_version {
        return Err(PluginFault::new(
            ErrorCode::Conflict,
            "页面草稿已在其他页面变化，请刷新读取",
        ));
    }
    let (saved, _): (StatePutResult, _) = history::callback(
        host,
        "host.state.put",
        StatePutRequest {
            namespace: "batches".into(),
            key: "workspace".into(),
            value: serde_json::to_value(req.draft).map_err(|_| history::invalid())?,
            expected_version: version,
        },
        vec![],
    )
    .await?;
    Ok(json!({"version":saved.version}))
}
