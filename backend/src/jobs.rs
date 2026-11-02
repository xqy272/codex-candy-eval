//! Persist intent before sending, outcome before scoring. Maintenance owns execution.
use crate::{
    evaluation::{self, Planned, RunRequest},
    history,
    management::{Active, ActiveGuard, AppState},
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
}
impl Job {
    fn terminal(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "stopped")
    }
    fn record(&self) -> Value {
        json!({"task":true,"id":self.request.id,"accountId":self.request.account_id,"accountName":self.account_name,"clientKeyId":self.request.client_key_id,"kind":self.request.kind,"model":self.request.model,"effort":self.request.effort,"requestProfile":self.request.profile,"status":self.status,"reason":self.reason,"verdict":self.verdict,"startedAt":self.started_at,"updatedAt":self.updated_at,"durationMs":self.duration_ms,"expectedSamples":self.plan.len(),"validSamples":self.accepted.iter().flatten().count(),"attempts":self.attempts,"sampleBytes":self.attempts.iter().map(|a|a.bytes).sum::<u64>(),"samples":[],"attribution":self.attribution,"detectorVersion":self.detector_version,"detectorRevision":self.detector_revision,"sourceHashes":self.source_hashes,"pluginVersion":self.plugin_version,"stopRequested":self.stop_requested,"canResume":self.status=="paused" && self.attempts.len()<MAX_ATTEMPTS})
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
pub async fn list(host: &HostClient) -> Result<Value, PluginFault> {
    Ok(json!({"records":index(host).await?.0}))
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
    let account = runtime(host, &req.account_id).await?;
    if account.provider_id != "openai" || !account.enabled {
        return Err(PluginFault::new(ErrorCode::Rejected, "账号不可用"));
    }
    let src = source()?;
    let plan = evaluation::plan(&req.kind)?;
    let job = Job {
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
    };
    save(host, &job).await?;
    Ok(json!({"record":job.record(),"duplicate":false}))
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
                let active = state.active.lock().map_err(|_| history::invalid())?;
                if let Some(a) = active.as_ref().filter(|a| a.id == id) {
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
    // One worker; management mutations hold this lock only while reading/writing state.
    let mut selected = None;
    let rx;
    {
        let _lock = state.admission.lock().await;
        if state
            .active
            .lock()
            .map_err(|_| history::invalid())?
            .is_some()
        {
            return Ok(());
        }
        for row in index(&call.host).await?.0.iter().rev() {
            let Some(id) = row["id"].as_str() else {
                continue;
            };
            let Some(mut job) = load(&call.host, id).await? else {
                let (mut rows, version) = index(&call.host).await?;
                rows.retain(|r| r["id"] != id);
                put(
                    &call.host,
                    "queue",
                    "index",
                    json!({"records":rows}),
                    version,
                )
                .await?;
                continue;
            };
            if job.status == "deleting" {
                remove(&call.host, id).await?;
                continue;
            }
            if job.status == "running" {
                if let Some(p) = job.pending.clone() {
                    if let Some((v, _)) = get(&call.host, "samples", &p.key).await? {
                        let bytes = serde_json::to_vec(&v)
                            .map_err(|_| history::invalid())?
                            .len() as u64;
                        let outcome = serde_json::from_value(v).map_err(|_| history::invalid())?;
                        attach(&state, &mut job, p, outcome, bytes);
                    } else {
                        // No durable outcome: never replay automatically, even if no request ID arrived.
                        attach(
                            &state,
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
                    save(&call.host, &job).await?;
                } else {
                    return Err(history::invalid());
                }
            }
            if matches!(job.status.as_str(), "queued" | "scoring") {
                selected = Some(job);
                break;
            }
        }
        let Some(ref job) = selected else {
            return Ok(());
        };
        let (tx, receiver) = watch::channel(false);
        rx = receiver;
        *state.active.lock().map_err(|_| history::invalid())? = Some(Active {
            id: job.request.id.clone(),
            cancel: tx,
        });
    }
    let _active = ActiveGuard(Arc::clone(&state));
    let mut job = selected.ok_or_else(history::invalid)?;
    loop {
        let _lock = state.admission.lock().await;
        job = load(&call.host, &job.request.id)
            .await?
            .ok_or_else(history::invalid)?;
        if job.stop_requested {
            job.status = "stopped".into();
            save(&call.host, &job).await?;
            return Ok(());
        }
        let src = source()?;
        if job.detector_revision != src["detectorRevision"] || job.source_hashes != hashes(&src) {
            job.status = "paused".into();
            job.reason = Some("baseline_changed".into());
            save(&call.host, &job).await?;
            return Ok(());
        }
        if job.status == "scoring" {
            if let Err(e) = score(&state, &call.host, &mut job).await {
                job.status = "paused".into();
                job.reason = Some("scoring_failed".into());
                save(&call.host, &job).await?;
                return Err(e);
            }
            save(&call.host, &job).await?;
            prune(&call.host).await?;
            return Ok(());
        }
        if job.status != "queued" {
            return Ok(());
        }
        // Reserve the complete model window plus storage/stream cleanup. No shortened probes.
        if call
            .host
            .remaining_budget()
            .is_some_and(|b| b < evaluation::required_budget(&job.request.kind))
        {
            return Ok(());
        }
        let src = source()?;
        if job.detector_revision != src["detectorRevision"] || job.source_hashes != hashes(&src) {
            job.status = "paused".into();
            job.reason = Some("baseline_changed".into());
            save(&call.host, &job).await?;
            return Ok(());
        }
        let account = match runtime(&call.host, &job.request.account_id).await {
            Ok(a) => a,
            Err(_) => {
                job.status = "paused".into();
                job.reason = Some("account_unavailable".into());
                save(&call.host, &job).await?;
                return Ok(());
            }
        };
        if !same_account(&job, &account) || !account.enabled {
            job.status = "paused".into();
            job.reason = Some("identity_changed".into());
            save(&call.host, &job).await?;
            return Ok(());
        }
        if job.attempts.len() >= MAX_ATTEMPTS {
            job.status = "paused".into();
            job.reason = Some("attempt_limit".into());
            save(&call.host, &job).await?;
            return Ok(());
        }
        let step = job
            .accepted
            .iter()
            .position(Option::is_none)
            .ok_or_else(history::invalid)?;
        let p = Pending {
            key: format!("{}-{}", job.request.id, job.attempts.len()),
            step,
        };
        job.status = "running".into();
        job.pending = Some(p.clone());
        job.updated_at = now();
        save(&call.host, &job).await?;
        drop(_lock);
        let started = Instant::now();
        let mut diagnostic = None;
        let mut cancel = rx.clone();
        let result = evaluation::ask(
            &call.host,
            &call.cancellation,
            &job.request,
            &job.plan[step],
            &mut cancel,
            &mut diagnostic,
        )
        .await;
        let (status, request_id, answer) = match result {
            Ok((id, a)) => ("completed".into(), Some(id), Some(a)),
            Err((id, s)) => (s.into(), id, None),
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
        // This deterministic outcome key lets recovery finish without sending the model request again.
        put(&call.host, "samples", &p.key, value, None).await?;
        job = load(&call.host, &job.request.id)
            .await?
            .ok_or_else(history::invalid)?;
        attach(&state, &mut job, p, outcome, bytes);
        save(&call.host, &job).await?;
        drop(_lock);
        if job.status == "paused" || job.status == "stopped" {
            return Ok(());
        }
    }
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
