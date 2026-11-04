//! Persist intent before sending, outcome before scoring. Maintenance owns execution.
use crate::{
    evaluation::{self, Planned, RunRequest},
    history,
    management::{AppState, Worker, WorkerGuard},
    model, prompts,
};
use gateway_plugin_sdk::{
    ErrorCode, PluginFault,
    call::host::{
        AuthGetRequest, AuthRuntimeAccount, StateDeleteRequest, StateGetRequest, StateGetResult,
        StatePutRequest, StatePutResult,
    },
    client::{Empty, HostClient, TypedCall},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;

const MAX_PENDING: usize = 16;
const MAX_TASKS: usize = 100;
const MAX_ATTEMPTS: usize = 9;
const SAMPLE_BUDGET: u64 = 12_000_000;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn conflict(message: &str) -> PluginFault {
    PluginFault::new(ErrorCode::Conflict, message)
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
fn observe(state: &AppState, record: &mut Value) -> Result<(), PluginFault> {
    if let Some(worker) = state
        .workers
        .lock()
        .map_err(|_| history::invalid())?
        .get(record["id"].as_str().unwrap_or_default())
    {
        record["progress"] = json!(*worker.progress.lock().map_err(|_| history::invalid())?);
    }
    Ok(())
}
pub async fn report_observed(
    state: &AppState,
    host: &HostClient,
    id: &str,
) -> Result<Value, PluginFault> {
    let mut value = report(host, id).await?;
    if value["record"].is_object() {
        observe(state, &mut value["record"])?;
    }
    Ok(value)
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchRequest {
    pub id: String,
    pub account_ids: Vec<String>,
    pub client_key_id: String,
    pub model: String,
    pub effort: String,
    pub kind: String,
    pub profile: String,
    pub repeats: usize,
    pub concurrency: usize,
    pub output_version: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Batch {
    request: BatchRequest,
    task_ids: Vec<String>,
    started_at: u64,
    ready: bool,
    stopped: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    stopped_accounts: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    prepared: Vec<Job>,
}
async fn concurrency(host: &HostClient) -> Result<usize, PluginFault> {
    Ok(get(host, "batches", "settings")
        .await?
        .and_then(|(v, _)| v["concurrency"].as_u64())
        .unwrap_or(2)
        .clamp(1, 4) as usize)
}
pub async fn batches(host: &HostClient) -> Result<Value, PluginFault> {
    let mut records = vec![];
    if let Some((v, _)) = get(host, "batches", "index").await? {
        for id in v["ids"].as_array().ok_or_else(history::invalid)? {
            if let Some((mut record, _)) =
                get(host, "batches", id.as_str().ok_or_else(history::invalid)?).await?
            {
                if let Some(v) = record.as_object_mut() {
                    v.remove("prepared");
                }
                records.push(record)
            }
        }
    }
    Ok(json!({"records":records,"concurrency":concurrency(host).await?}))
}
pub async fn submit_batch(
    state: &Arc<AppState>,
    host: &HostClient,
    req: BatchRequest,
) -> Result<Value, PluginFault> {
    let _lock = state.admission.lock().await;
    if !valid_id(&req.id)
        || matches!(req.id.as_str(), "index" | "settings" | "workspace")
        || req.id.len() > 80
        || req.account_ids.is_empty()
        || req.account_ids.len() > 16
        || !(1..=4).contains(&req.concurrency)
        || ![1, 3, 5].contains(&req.repeats)
        || (req.kind != "candy" && req.repeats != 1)
        || !matches!(
            req.output_version.as_str(),
            "svg-v1" | "legacy-animation-v1"
        )
        || req
            .account_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != req.account_ids.len()
    {
        return Err(PluginFault::new(
            ErrorCode::InvalidInput,
            "批次目标、次数或并行上限无效",
        ));
    }
    let existing = get(host, "batches", &req.id).await?;
    let mut batch = if let Some((v, _)) = &existing {
        let b: Batch = serde_json::from_value(v.clone()).map_err(|_| history::invalid())?;
        if b.request != req {
            return Err(conflict("相同批次 ID 不可改变检测条件"));
        }
        b
    } else {
        let task_count = req.account_ids.len() * req.repeats;
        let rows = index(host).await?.0;
        if rows
            .iter()
            .filter(|r| !matches!(r["status"].as_str(), Some("completed" | "stopped")))
            .count()
            + task_count
            > MAX_PENDING
        {
            return Err(PluginFault::new(
                ErrorCode::Capacity,
                "未结束检测最多 16 份，请减少账号或次数，或先处理已有检测",
            ));
        }
        let mut ids = get(host, "batches", "index")
            .await?
            .map(|(v, _)| v["ids"].as_array().cloned().unwrap_or_default())
            .unwrap_or_default();
        if ids.len() >= 100 {
            let removable = ids
                .iter()
                .rev()
                .find(|id| {
                    !rows.iter().any(|r| {
                        r["batchId"] == **id
                            && !matches!(r["status"].as_str(), Some("completed" | "stopped"))
                    })
                })
                .cloned()
                .ok_or_else(|| conflict("请先处理已有批次"))?;
            delete(
                host,
                "batches",
                removable.as_str().ok_or_else(history::invalid)?,
            )
            .await?;
            ids.retain(|id| *id != removable);
        }
        let mut jobs = vec![];
        for (a, account_id) in req.account_ids.iter().enumerate() {
            for n in 0..req.repeats {
                let request = RunRequest {
                    id: format!("{}-{a}-{n}", req.id),
                    account_id: account_id.clone(),
                    client_key_id: req.client_key_id.clone(),
                    model: req.model.clone(),
                    effort: req.effort.clone(),
                    kind: req.kind.clone(),
                    step: 0,
                    profile: req.profile.clone(),
                };
                if !request.valid() {
                    return Err(PluginFault::new(
                        ErrorCode::InvalidInput,
                        "请选择有效的模型、Key 和测试条件",
                    ));
                }
                jobs.push(
                    new_job(
                        state,
                        host,
                        request,
                        Some(req.id.clone()),
                        Some(req.output_version.clone()),
                    )
                    .await?,
                );
            }
        }
        if concurrency(host).await? != req.concurrency && has_pending(host).await? {
            return Err(conflict("请在已有批次结束后调整实例并行上限"));
        }
        let b = Batch {
            task_ids: jobs.iter().map(|j| j.request.id.clone()).collect(),
            request: req.clone(),
            started_at: now(),
            ready: false,
            stopped: false,
            stopped_accounts: vec![],
            prepared: jobs,
        };
        // Reserve the index first so interrupted creation cannot leak an unlisted batch.
        // No child can run until the frozen batch is ready.
        ids.retain(|id| *id != req.id);
        ids.insert(0, json!(req.id));
        let version = get(host, "batches", "index").await?.map(|(_, v)| v);
        put(host, "batches", "index", json!({"ids":ids}), version).await?;
        put(host, "batches", &req.id, json!(b), None).await?;
        b
    };
    if !batch.ready && !batch.stopped {
        let (index_value, index_version) = get(host, "batches", "index")
            .await?
            .map(|(v, n)| (v, Some(n)))
            .unwrap_or((json!({"ids":[]}), None));
        let mut ids = index_value["ids"]
            .as_array()
            .cloned()
            .ok_or_else(history::invalid)?;
        if !ids.contains(&json!(req.id)) {
            ids.insert(0, json!(req.id));
            put(host, "batches", "index", json!({"ids":ids}), index_version).await?;
        }
        for job in &batch.prepared {
            if load(host, &job.request.id).await?.is_none() {
                prune(host).await?;
                save(host, job).await?;
            }
        }
        let version = get(host, "batches", "settings").await?.map(|(_, v)| v);
        put(
            host,
            "batches",
            "settings",
            json!({"concurrency":req.concurrency}),
            version,
        )
        .await?;
        batch.ready = true;
        batch.prepared.clear();
        let version = get(host, "batches", &req.id).await?.map(|(_, v)| v);
        put(host, "batches", &req.id, json!(batch), version).await?;
    }
    Ok(json!({"batch":batch,"duplicate":existing.is_some()}))
}
pub async fn stop_batch(
    state: &Arc<AppState>,
    host: &HostClient,
    id: &str,
) -> Result<Value, PluginFault> {
    stop_scope(state, host, id, None).await
}
pub async fn stop_account(
    state: &Arc<AppState>,
    host: &HostClient,
    id: &str,
    account_id: &str,
) -> Result<Value, PluginFault> {
    stop_scope(state, host, id, Some(account_id)).await
}
fn batch_stops(batch: &Value, account_id: &str) -> bool {
    batch["stopped"] == true
        || batch["stoppedAccounts"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(account_id)))
}
async fn stop_scope(
    state: &Arc<AppState>,
    host: &HostClient,
    id: &str,
    account_id: Option<&str>,
) -> Result<Value, PluginFault> {
    let batch = {
        let _lock = state.admission.lock().await;
        let (v, version) = get(host, "batches", id)
            .await?
            .ok_or_else(|| conflict("批次不存在"))?;
        let mut batch: Batch = serde_json::from_value(v).map_err(|_| history::invalid())?;
        if let Some(account) = account_id {
            if !batch.request.account_ids.iter().any(|a| a == account) {
                return Err(conflict("账号不属于此批次"));
            }
            if !batch.stopped_accounts.iter().any(|a| a == account) {
                batch.stopped_accounts.push(account.into());
            }
        } else {
            batch.stopped = true;
            batch.prepared.clear();
        }
        put(host, "batches", id, json!(batch), Some(version)).await?;
        batch
    };
    for id in batch.task_ids {
        if load(host, &id)
            .await?
            .is_some_and(|j| account_id.is_none_or(|a| j.request.account_id == a))
        {
            action(state, host, &id, "api/stop").await?;
        }
    }
    Ok(json!({"stopped":true}))
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    authentication_kind: String,
    upstream_user_id: Option<String>,
    upstream_account_id: Option<String>,
}
impl From<&AuthRuntimeAccount> for Identity {
    fn from(a: &AuthRuntimeAccount) -> Self {
        Self {
            authentication_kind: a.authentication_kind.clone(),
            upstream_user_id: a.upstream_user_id.clone(),
            upstream_account_id: a.upstream_account_id.clone(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub key: String,
    pub step: usize,
    pub status: String,
    pub valid: bool,
    pub request_id: Option<String>,
    pub duration_ms: u64,
    pub bytes: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    key: String,
    step: usize,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub request: RunRequest,
    pub account_name: String,
    identity: Identity,
    credential_revision: u64,
    pub status: String,
    pub reason: Option<String>,
    pub plan: Vec<Planned>,
    pub accepted: Vec<Option<String>>,
    pub attempts: Vec<Attempt>,
    pub pending: Option<Pending>,
    pub stop_requested: bool,
    pub started_at: u64,
    pub updated_at: u64,
    pub duration_ms: u64,
    pub attribution: Option<Value>,
    pub verdict: Option<String>,
    pub detector_revision: Value,
    pub source_hashes: Value,
    pub detector_version: String,
    pub plugin_version: String,
    #[serde(default)]
    pub batch_id: Option<String>,
    #[serde(default)]
    pub output_version: Option<String>,
}
impl Job {
    fn terminal(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "stopped")
    }
    fn record(&self) -> Value {
        json!({"task":true,"id":self.request.id,"batchId":self.batch_id,"outputVersion":self.output_version,"accountId":self.request.account_id,"accountName":self.account_name,"clientKeyId":self.request.client_key_id,"kind":self.request.kind,"model":self.request.model,"effort":self.request.effort,"requestProfile":self.request.profile,"status":self.status,"reason":self.reason,"verdict":self.verdict,"startedAt":self.started_at,"updatedAt":self.updated_at,"durationMs":self.duration_ms,"expectedSamples":self.plan.len(),"validSamples":self.accepted.iter().flatten().count(),"attempts":self.attempts,"sampleBytes":self.attempts.iter().map(|a|a.bytes).sum::<u64>(),"samples":[],"attribution":self.attribution,"detectorVersion":self.detector_version,"detectorRevision":self.detector_revision,"sourceHashes":self.source_hashes,"pluginVersion":self.plugin_version,"stopRequested":self.stop_requested,"canResume":self.status=="paused" && self.attempts.len()<MAX_ATTEMPTS && !matches!(self.reason.as_deref(),Some("identity_changed"|"baseline_changed"|"account_unavailable"|"permission_denied"))})
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub status: String,
    pub request_id: Option<String>,
    pub answer: Option<model::Answer>,
    pub duration_ms: u64,
    pub error: Option<Value>,
}
async fn get(host: &HostClient, ns: &str, key: &str) -> Result<Option<(Value, u64)>, PluginFault> {
    let (v, _): (StateGetResult, _) = history::callback(
        host,
        "host.state.get",
        StateGetRequest {
            namespace: ns.into(),
            key: key.into(),
        },
        vec![],
    )
    .await?;
    Ok(v.record.map(|r| (r.value, r.version)))
}
async fn put(
    host: &HostClient,
    ns: &str,
    key: &str,
    value: Value,
    version: Option<u64>,
) -> Result<(), PluginFault> {
    if serde_json::to_vec(&value)
        .map_err(|_| history::invalid())?
        .len()
        > 250_000
    {
        return Err(PluginFault::new(ErrorCode::Capacity, "记录超过存储上限"));
    }
    let _: (StatePutResult, _) = history::callback(
        host,
        "host.state.put",
        StatePutRequest {
            namespace: ns.into(),
            key: key.into(),
            value,
            expected_version: version,
        },
        vec![],
    )
    .await?;
    Ok(())
}
async fn delete(host: &HostClient, ns: &str, key: &str) -> Result<(), PluginFault> {
    if let Some((_, version)) = get(host, ns, key).await? {
        let _: (gateway_plugin_sdk::call::host::StateDeleteResult, _) = history::callback(
            host,
            "host.state.delete",
            StateDeleteRequest {
                namespace: ns.into(),
                key: key.into(),
                expected_version: version,
            },
            vec![],
        )
        .await?;
    }
    Ok(())
}
async fn index(host: &HostClient) -> Result<(Vec<Value>, Option<u64>), PluginFault> {
    match get(host, "queue", "index").await? {
        Some((v, version)) => Ok((
            serde_json::from_value(v["records"].clone()).map_err(|_| history::invalid())?,
            Some(version),
        )),
        None => Ok((vec![], None)),
    }
}
async fn load(host: &HostClient, id: &str) -> Result<Option<Job>, PluginFault> {
    if !valid_id(id) {
        return Err(PluginFault::new(ErrorCode::InvalidInput, "任务 ID 无效"));
    }
    get(host, "tasks", id)
        .await?
        .map(|(v, _)| serde_json::from_value(v).map_err(|_| history::invalid()))
        .transpose()
}
async fn save(host: &HostClient, job: &Job) -> Result<(), PluginFault> {
    let version = get(host, "tasks", &job.request.id).await?.map(|(_, v)| v);
    put(
        host,
        "tasks",
        &job.request.id,
        serde_json::to_value(job).map_err(|_| history::invalid())?,
        version,
    )
    .await?;
    let (mut rows, version) = index(host).await?;
    rows.retain(|r| r["id"] != job.request.id);
    rows.insert(0, job.record());
    // Summaries exclude verbose ranks and sample pointers; report reads the task.
    for r in &mut rows {
        r["attempts"] = json!([]);
        if let Some(a) = r["attribution"].as_object_mut() {
            a.retain(|k, _| matches!(k.as_str(), "prediction_name" | "decision" | "used_outputs"));
        }
    }
    put(host, "queue", "index", json!({"records":rows}), version).await
}
async fn runtime(host: &HostClient, id: &str) -> Result<AuthRuntimeAccount, PluginFault> {
    let (_, payload): (Value, _) = history::callback(
        host,
        "host.auth.get_runtime",
        json!({}),
        serde_json::to_vec(&AuthGetRequest {
            account_id: id.into(),
        })
        .map_err(|_| history::invalid())?,
    )
    .await?;
    serde_json::from_slice(&payload).map_err(|_| history::invalid())
}
fn source() -> Result<Value, PluginFault> {
    serde_json::from_slice(include_bytes!("../../vendor/SOURCES.json"))
        .map_err(|_| history::invalid())
}
fn hashes(s: &Value) -> Value {
    json!({"suite":s["files"]["data/enrollment-suite.json"],"bank":s["files"]["data/unified_bank.json"],"context":s["files"]["data/codex-context.json"],"algorithm":"lmfpd-0.2.0/strict-three-v1"})
}
fn same_account(job: &Job, a: &AuthRuntimeAccount) -> bool {
    Identity::from(a) == job.identity
        && (job.identity.upstream_user_id.is_some()
            || job.identity.upstream_account_id.is_some()
            || job.credential_revision == a.credential_revision)
}
pub async fn has_pending(host: &HostClient) -> Result<bool, PluginFault> {
    Ok(index(host)
        .await?
        .0
        .iter()
        .any(|r| matches!(r["status"].as_str(), Some("queued" | "running" | "scoring"))))
}
pub async fn list(state: &AppState, host: &HostClient) -> Result<Value, PluginFault> {
    let mut rows = index(host).await?.0;
    for r in &mut rows {
        observe(state, r)?;
    }
    Ok(json!({"records":rows}))
}
async fn remove(host: &HostClient, id: &str) -> Result<(), PluginFault> {
    if let Some(mut job) = load(host, id).await? {
        // Retain a durable tombstone until all sample deletions have completed.
        job.status = "deleting".into();
        save(host, &job).await?;
        for a in job.attempts {
            delete(host, "samples", &a.key).await?;
        }
        if let Some(p) = job.pending {
            delete(host, "samples", &p.key).await?;
        }
        delete(host, "tasks", id).await?;
    }
    let (mut rows, version) = index(host).await?;
    rows.retain(|r| r["id"] != id);
    put(host, "queue", "index", json!({"records":rows}), version).await
}
async fn prune(host: &HostClient) -> Result<(), PluginFault> {
    loop {
        let (rows, _) = index(host).await?;
        if rows.len() < MAX_TASKS
            && rows
                .iter()
                .map(|r| r["sampleBytes"].as_u64().unwrap_or(0))
                .sum::<u64>()
                < SAMPLE_BUDGET
        {
            return Ok(());
        }
        let id = rows
            .iter()
            .rev()
            .find(|r| matches!(r["status"].as_str(), Some("completed" | "stopped")))
            .and_then(|r| r["id"].as_str())
            .ok_or_else(|| PluginFault::new(ErrorCode::Capacity, "请先清理已结束的检测"))?;
        remove(host, id).await?;
    }
}
pub async fn submit(
    state: &Arc<AppState>,
    host: &HostClient,
    req: RunRequest,
) -> Result<Value, PluginFault> {
    if !req.valid() || req.step != 0 || !valid_id(&req.id) {
        return Err(PluginFault::new(ErrorCode::InvalidInput, "检测参数无效"));
    }
    let _lock = state.admission.lock().await;
    if let Some(job) = load(host, &req.id).await? {
        if job.request != req {
            return Err(conflict("相同 ID 不可改变检测条件"));
        }
        save(host, &job).await?;
        return Ok(json!({"record":job.record(),"duplicate":true}));
    }
    if index(host)
        .await?
        .0
        .iter()
        .filter(|r| !matches!(r["status"].as_str(), Some("completed" | "stopped")))
        .count()
        >= MAX_PENDING
    {
        return Err(PluginFault::new(ErrorCode::Capacity, "待处理任务已达上限"));
    }
    prune(host).await?;
    let job = new_job(state, host, req, None, None).await?;
    save(host, &job).await?;
    Ok(json!({"record":job.record(),"duplicate":false}))
}
async fn new_job(
    state: &AppState,
    host: &HostClient,
    req: RunRequest,
    batch_id: Option<String>,
    output_version: Option<String>,
) -> Result<Job, PluginFault> {
    let account = runtime(host, &req.account_id).await?;
    if account.provider_id != "openai" || !account.enabled {
        return Err(PluginFault::new(ErrorCode::Rejected, "账号不可用"));
    }
    let src = source()?;
    let mut plan = evaluation::plan(&req.kind)?;
    if req.kind == "pelican" && output_version.as_deref() == Some("svg-v1") {
        plan[0].prompt="Draw a pelican riding a bicycle as a complete standalone SVG. Output only the SVG, without Markdown, HTML, JavaScript, external assets, or explanatory text.".into();
    }
    Ok(Job {
        request: req,
        account_name: account.name.clone(),
        identity: Identity::from(&account),
        credential_revision: account.credential_revision,
        status: "queued".into(),
        reason: None,
        accepted: vec![None; plan.len()],
        plan,
        attempts: vec![],
        pending: None,
        stop_requested: false,
        started_at: now(),
        updated_at: now(),
        duration_ms: 0,
        attribution: None,
        verdict: None,
        detector_revision: src["detectorRevision"].clone(),
        source_hashes: hashes(&src),
        detector_version: state.detector.built_at().into(),
        plugin_version: env!("CARGO_PKG_VERSION").into(),
        batch_id,
        output_version,
    })
}
pub async fn report(host: &HostClient, id: &str) -> Result<Value, PluginFault> {
    let record=load(host,id).await?.map(|j| {
        let mut value=j.record();
        value["identitySnapshot"]=json!(j.identity);
        value["credentialRevision"]=json!(j.credential_revision);
        value["frozenPlan"]=json!(j.plan);
        value["samplingPolicy"]=json!({"requiresCompletedResponse":true,"strict":true,"pluginAutomaticRetries":0,"upstreamAttempts":null});
        value
    });
    Ok(json!({"record":record}))
}
pub async fn sample(host: &HostClient, id: &str, key: &str) -> Result<Value, PluginFault> {
    let job = load(host, id)
        .await?
        .ok_or_else(|| conflict("任务已清理"))?;
    let a = job
        .attempts
        .iter()
        .find(|a| a.key == key)
        .ok_or_else(|| conflict("样本不属于此任务"))?;
    let mut value = match get(host, "samples", key).await? {
        Some((v, _)) => v,
        None if a.bytes == 0 => {
            json!({"status":a.status,"requestId":a.request_id,"answer":null,"durationMs":a.duration_ms,"error":null})
        }
        None => return Err(history::invalid()),
    };
    let p = &job.plan[a.step];
    value["prompt"] = json!(p.prompt);
    value["instructions"] = json!(p.instructions);
    value["expectedCount"] = json!(p.expected_count);
    value["valid"] = json!(a.valid);
    value["step"] = json!(a.step);
    Ok(json!({"sample":value}))
}
pub async fn action(
    state: &Arc<AppState>,
    host: &HostClient,
    id: &str,
    action: &str,
) -> Result<Value, PluginFault> {
    let _lock = state.admission.lock().await;
    let mut job = load(host, id)
        .await?
        .ok_or_else(|| conflict("任务不存在"))?;
    if action == "api/resume"
        && let Some(batch) = &job.batch_id
        && get(host, "batches", batch)
            .await?
            .is_some_and(|(v, _)| batch_stops(&v, &job.request.account_id))
    {
        return Err(conflict("该批次已停止，请新建检测"));
    }
    match action {
        "api/delete" => {
            if !job.terminal() && job.status != "paused" {
                return Err(conflict("请先停止活动任务"));
            }
            remove(host, id).await?;
            return Ok(json!({"deleted":true}));
        }
        "api/stop" => {
            if job.terminal() {
                return Ok(json!({"record":job.record()}));
            }
            job.stop_requested = true;
            let active = {
                let active = state.workers.lock().map_err(|_| history::invalid())?;
                if let Some(a) = active.get(id) {
                    a.cancel.send_replace(true);
                    true
                } else {
                    false
                }
            };
            if !active {
                if let Some(p) = job.pending.clone() {
                    if let Some((v, _)) = get(host, "samples", &p.key).await? {
                        let bytes = serde_json::to_vec(&v)
                            .map_err(|_| history::invalid())?
                            .len() as u64;
                        attach(
                            state,
                            &mut job,
                            p,
                            serde_json::from_value(v).map_err(|_| history::invalid())?,
                            bytes,
                        );
                    } else {
                        attach(
                            state,
                            &mut job,
                            p,
                            Outcome {
                                status: "uncertain".into(),
                                request_id: None,
                                answer: None,
                                duration_ms: 0,
                                error: None,
                            },
                            0,
                        );
                    }
                }
                job.status = "stopped".into();
            }
        }
        "api/resume" => {
            if job.status == "queued" {
                return Ok(json!({"record":job.record()}));
            }
            if job.status != "paused" || job.attempts.len() >= MAX_ATTEMPTS {
                return Err(conflict("该任务不能继续，请新建检测"));
            }
            let src = source()?;
            if job.detector_revision != src["detectorRevision"] || job.source_hashes != hashes(&src)
            {
                return Err(conflict("检测器或参考资源已变化，请新建检测"));
            }
            let account = runtime(host, &job.request.account_id).await?;
            if !same_account(&job, &account) || !account.enabled {
                return Err(conflict("上游身份已改变或账号不可用，请新建检测"));
            }
            job.status = if job.accepted.iter().all(Option::is_some) {
                "scoring"
            } else {
                "queued"
            }
            .into();
            job.reason = None;
            job.stop_requested = false;
        }
        _ => return Err(history::invalid()),
    }
    job.updated_at = now();
    save(host, &job).await?;
    Ok(json!({"record":job.record()}))
}
fn accept(state: &AppState, job: &Job, step: usize, o: &Outcome) -> bool {
    if o.status != "completed" {
        return false;
    }
    let Some(answer) = o.answer.as_ref().filter(|a| a.completed) else {
        return false;
    };
    if job.request.kind != "fingerprint" {
        return true;
    }
    state
        .detector
        .analyze(
            &[lmfpd::Output {
                text: answer.text.clone(),
                expected_count: job.plan[step].expected_count.unwrap_or(0),
            }],
            true,
        )
        .is_ok_and(|a| a.used_outputs == 1)
}
fn attach(state: &AppState, job: &mut Job, p: Pending, o: Outcome, bytes: u64) {
    let valid = accept(state, job, p.step, &o);
    if valid {
        job.accepted[p.step] = Some(p.key.clone());
    }
    job.duration_ms += o.duration_ms;
    job.attempts.push(Attempt {
        key: p.key,
        step: p.step,
        status: o.status.clone(),
        valid,
        request_id: o.request_id,
        duration_ms: o.duration_ms,
        bytes,
    });
    job.pending = None;
    job.updated_at = now();
    if job.stop_requested {
        job.status = "stopped".into();
        job.reason = Some("user_stopped".into());
    } else if !valid {
        job.status = "paused".into();
        job.reason = Some(if o.status == "completed" {
            "invalid_sample".into()
        } else {
            o.status
        });
    } else if job.accepted.iter().all(Option::is_some) {
        job.status = "scoring".into();
        job.reason = None;
    } else {
        job.status = "queued".into();
        job.reason = None;
    }
}
async fn score(state: &AppState, host: &HostClient, job: &mut Job) -> Result<(), PluginFault> {
    let mut outputs = vec![];
    for (i, key) in job.accepted.iter().enumerate() {
        let (v, _) = get(
            host,
            "samples",
            key.as_deref().ok_or_else(history::invalid)?,
        )
        .await?
        .ok_or_else(history::invalid)?;
        outputs.push(lmfpd::Output {
            text: v["answer"]["text"]
                .as_str()
                .ok_or_else(history::invalid)?
                .into(),
            expected_count: job.plan[i].expected_count.unwrap_or(0),
        });
    }
    match job.request.kind.as_str() {
        "candy" => {
            job.verdict = Some(
                if prompts::has_answer(&outputs[0].text) {
                    "correct"
                } else {
                    "wrong"
                }
                .into(),
            )
        }
        "fingerprint" => {
            let analysis = state
                .detector
                .analyze(&outputs, true)
                .map_err(|_| history::invalid())?;
            job.verdict = Some(
                if analysis.results.is_empty() {
                    "insufficient"
                } else {
                    "ranked"
                }
                .into(),
            );
            job.attribution = Some(serde_json::to_value(analysis).map_err(|_| history::invalid())?);
        }
        _ => job.verdict = Some("output".into()),
    }
    job.status = "completed".into();
    job.updated_at = now();
    Ok(())
}
pub async fn tick(state: Arc<AppState>, call: &TypedCall<Empty>) -> Result<(), PluginFault> {
    let mut workers = tokio::task::JoinSet::new();
    let mut first_error = None;
    loop {
        loop {
            let candidate = {
                let _lock = state.admission.lock().await;
                match select_next(&state, &call.host).await {
                    Ok(candidate) => candidate,
                    Err(error) => {
                        first_error = Some(error);
                        None
                    }
                }
            };
            let Some((job, rx, progress, guard)) = candidate else {
                break;
            };
            let host = call.host.clone();
            let cancellation = call.cancellation.clone();
            let worker_state = Arc::clone(&state);
            workers.spawn(async move {
                run_one(worker_state, host, cancellation, job, rx, progress, guard).await
            });
        }
        let Some(result) = workers.join_next().await else {
            break;
        };
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if first_error.is_none() {
                    first_error = Some(e)
                }
            }
            Err(_) => {
                if first_error.is_none() {
                    first_error = Some(history::invalid())
                }
            }
        }
        // State failures do not abort sibling requests. Drain them, leave intents recoverable.
        if first_error.is_some() {
            while workers.join_next().await.is_some() {}
            break;
        }
    }
    first_error.map_or(Ok(()), Err)
}
type Selected = (
    Job,
    watch::Receiver<bool>,
    Arc<std::sync::Mutex<model::Progress>>,
    WorkerGuard,
);
async fn select_next(
    state: &Arc<AppState>,
    host: &HostClient,
) -> Result<Option<Selected>, PluginFault> {
    if state
        .active
        .lock()
        .map_err(|_| history::invalid())?
        .is_some()
    {
        return Ok(None);
    }
    let limit = concurrency(host).await?;
    if state.workers.lock().map_err(|_| history::invalid())?.len() >= limit {
        return Ok(None);
    }
    for row in index(host).await?.0.iter().rev() {
        let Some(id) = row["id"].as_str() else {
            continue;
        };
        if state
            .workers
            .lock()
            .map_err(|_| history::invalid())?
            .contains_key(id)
        {
            continue;
        }
        let Some(mut job) = load(host, id).await? else {
            let (mut rows, version) = index(host).await?;
            rows.retain(|r| r["id"] != id);
            put(host, "queue", "index", json!({"records":rows}), version).await?;
            continue;
        };
        if job.status == "deleting" {
            remove(host, id).await?;
            continue;
        }
        if job.status == "running" {
            let p = job.pending.clone().ok_or_else(history::invalid)?;
            let (outcome, bytes) = if let Some((v, _)) = get(host, "samples", &p.key).await? {
                let bytes = serde_json::to_vec(&v)
                    .map_err(|_| history::invalid())?
                    .len() as u64;
                (
                    serde_json::from_value(v).map_err(|_| history::invalid())?,
                    bytes,
                )
            } else {
                (
                    Outcome {
                        status: "uncertain".into(),
                        request_id: None,
                        answer: None,
                        duration_ms: 0,
                        error: None,
                    },
                    0,
                )
            };
            attach(state, &mut job, p, outcome, bytes);
            save(host, &job).await?;
        }
        if let Some(batch) = &job.batch_id {
            let Some((v, _)) = get(host, "batches", batch).await? else {
                continue;
            };
            if batch_stops(&v, &job.request.account_id) {
                if !job.terminal() {
                    job.stop_requested = true;
                    job.status = "stopped".into();
                    save(host, &job).await?;
                }
                continue;
            }
            if v["ready"] != true {
                continue;
            }
        }
        if !matches!(job.status.as_str(), "queued" | "scoring") {
            continue;
        }
        if state
            .workers
            .lock()
            .map_err(|_| history::invalid())?
            .values()
            .any(|w| w.account_id == job.request.account_id)
        {
            continue;
        }
        if job.stop_requested {
            job.status = "stopped".into();
            save(host, &job).await?;
            continue;
        }
        let src = source()?;
        if job.detector_revision != src["detectorRevision"] || job.source_hashes != hashes(&src) {
            job.status = "paused".into();
            job.reason = Some("baseline_changed".into());
            save(host, &job).await?;
            continue;
        }
        if job.status == "scoring" {
            if score(state, host, &mut job).await.is_err() {
                job.status = "paused".into();
                job.reason = Some("scoring_failed".into());
            }
            save(host, &job).await?;
            prune(host).await?;
            continue;
        }
        if host
            .remaining_budget()
            .is_some_and(|b| b < evaluation::required_budget(&job.request.kind))
        {
            continue;
        }
        let account = match runtime(host, &job.request.account_id).await {
            Ok(a) => a,
            Err(_) => {
                job.status = "paused".into();
                job.reason = Some("account_unavailable".into());
                save(host, &job).await?;
                continue;
            }
        };
        if !same_account(&job, &account) || !account.enabled {
            job.status = "paused".into();
            job.reason = Some("identity_changed".into());
            save(host, &job).await?;
            continue;
        }
        if job.attempts.len() >= MAX_ATTEMPTS {
            job.status = "paused".into();
            job.reason = Some("attempt_limit".into());
            save(host, &job).await?;
            continue;
        }
        let step = job
            .accepted
            .iter()
            .position(Option::is_none)
            .ok_or_else(history::invalid)?;
        job.pending = Some(Pending {
            key: format!("{}-{}", job.request.id, job.attempts.len()),
            step,
        });
        job.status = "running".into();
        job.updated_at = now();
        save(host, &job).await?;
        let (tx, rx) = watch::channel(false);
        let progress = Arc::new(std::sync::Mutex::new(model::Progress {
            phase: "requesting".into(),
            step,
            started_at: now(),
            ..Default::default()
        }));
        state
            .workers
            .lock()
            .map_err(|_| history::invalid())?
            .insert(
                id.into(),
                Worker {
                    account_id: job.request.account_id.clone(),
                    cancel: tx,
                    progress: Arc::clone(&progress),
                },
            );
        let guard = WorkerGuard(Arc::clone(state), id.into());
        return Ok(Some((job, rx, progress, guard)));
    }
    Ok(None)
}
async fn run_one(
    state: Arc<AppState>,
    host: HostClient,
    cancellation: gateway_plugin_sdk::client::CallCancellation,
    mut job: Job,
    mut cancel: watch::Receiver<bool>,
    progress: Arc<std::sync::Mutex<model::Progress>>,
    _guard: WorkerGuard,
) -> Result<(), PluginFault> {
    let p = job.pending.clone().ok_or_else(history::invalid)?;
    let started = Instant::now();
    let mut diagnostic = None;
    let result = evaluation::ask_observed(
        &host,
        &cancellation,
        &job.request,
        &job.plan[p.step],
        &mut cancel,
        &mut diagnostic,
        Some(&progress),
    )
    .await;
    let (status, request_id, answer) = match result {
        Ok((id, a)) => ("completed".into(), Some(id), Some(a)),
        Err((id, s)) => {
            let partial = diagnostic
                .as_mut()
                .and_then(|d| d.as_object_mut())
                .and_then(|d| d.remove("partialAnswer"))
                .and_then(|v| serde_json::from_value(v).ok());
            (s.into(), id, partial)
        }
    };
    let outcome = Outcome {
        status,
        request_id,
        answer,
        duration_ms: started.elapsed().as_millis() as u64,
        error: diagnostic,
    };
    let value = serde_json::to_value(&outcome).map_err(|_| history::invalid())?;
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| history::invalid())?
        .len() as u64;
    let _lock = state.admission.lock().await;
    put(&host, "samples", &p.key, value, None).await?;
    job = load(&host, &job.request.id)
        .await?
        .ok_or_else(history::invalid)?;
    attach(&state, &mut job, p, outcome, bytes);
    save(&host, &job).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn state_keys_reject_paths_and_controls() {
        assert!(valid_id("round-123_4"));
        for s in ["../x", "a/b", "a\n", ""] {
            assert!(!valid_id(s));
        }
    }
}
