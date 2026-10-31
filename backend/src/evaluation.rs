//! 按题执行并持久保存进度，未知消费结果不会自动重放
use crate::{history, management::AppState, model, prompts};
use gateway_plugin_sdk::{
    ErrorCode, PluginFault,
    call::{
        host::{ModelExecuteRequest, ModelExecuteResult, ModelOperation},
        management::ManagementRequest,
    },
    client::TypedCall,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;

fn default_profile() -> String {
    "simple-v1".into()
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequest {
    pub id: String,
    pub account_id: String,
    pub client_key_id: String,
    pub model: String,
    pub effort: String,
    pub kind: String,
    #[serde(default)]
    pub step: u8,
    #[serde(default = "default_profile")]
    pub profile: String,
}
impl RunRequest {
    pub fn valid(&self) -> bool {
        [&self.id, &self.account_id, &self.client_key_id, &self.model]
            .into_iter()
            .all(|s| !s.trim().is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
            && matches!(self.kind.as_str(), "candy" | "fingerprint" | "pelican")
            && matches!(
                self.effort.as_str(),
                "" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
            )
            && matches!(self.profile.as_str(), "simple-v1" | "codex-context-v1")
            && self.step < if self.kind == "fingerprint" { 3 } else { 1 }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Planned {
    prompt: String,
    instructions: String,
    expected_count: Option<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    prompt: String,
    instructions: String,
    expected_count: Option<u64>,
    request_id: Option<String>,
    status: String,
    answer: Option<model::Answer>,
    duration_ms: u64,
}
#[derive(Deserialize)]
struct Challenge {
    system: String,
    user_prefix: String,
    prompt: String,
    expected_count: u64,
}
fn conflict() -> PluginFault {
    PluginFault::new(ErrorCode::Conflict, "测试进度已变化，请刷新记录")
}

fn plan(kind: &str) -> Result<Vec<Planned>, PluginFault> {
    if kind != "fingerprint" {
        return Ok(vec![Planned {
            prompt: if kind == "candy" {
                prompts::CANDY
            } else {
                prompts::PELICAN
            }
            .into(),
            instructions:
                "Answer the user's request directly without using tools or external resources."
                    .into(),
            expected_count: None,
        }]);
    }
    let suite: Vec<Challenge> =
        serde_json::from_slice(include_bytes!("../../data/enrollment-suite.json"))
            .map_err(|_| history::invalid())?;
    let mut indices: Vec<usize> = (0..suite.len()).collect();
    let mut selected = Vec::new();
    for _ in 0..3 {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).map_err(|_| history::invalid())?;
        let index =
            indices.swap_remove((u64::from_le_bytes(bytes) % indices.len() as u64) as usize);
        let c = &suite[index];
        selected.push(Planned {
            prompt: if c.user_prefix.is_empty() {
                c.prompt.clone()
            } else {
                format!("{}\n\nFinal task:\n{}", c.user_prefix, c.prompt)
            },
            instructions: c.system.clone(),
            expected_count: Some(c.expected_count),
        });
    }
    Ok(selected)
}

async fn ask(
    call: &TypedCall<ManagementRequest>,
    req: &RunRequest,
    p: &Planned,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(String, model::Answer), (Option<String>, &'static str)> {
    if *cancel.borrow() {
        return Err((None, "cancelled"));
    }
    let mut body = json!({"model":req.model,"instructions":p.instructions,"input":[{"role":"user","content":p.prompt}],"stream":true,"store":false,"tools":[],"tool_choice":"none"});
    if req.profile == "codex-context-v1" {
        let context: Value =
            serde_json::from_slice(include_bytes!("../../data/codex-context.json"))
                .map_err(|_| (None, "invalid_request"))?;
        body["instructions"] = json!(format!(
            "{}\n\n{}",
            context["base_instructions"].as_str().unwrap_or_default(),
            p.instructions
        ));
        let mut input = Vec::new();
        for message in context["messages"]
            .as_array()
            .ok_or((None, "invalid_request"))?
        {
            let content: Vec<Value> = message["content"]
                .as_array()
                .ok_or((None, "invalid_request"))?
                .iter()
                .map(|part| json!({"type":"input_text","text":part["text"]}))
                .collect();
            input.push(json!({"role":message["role"],"content":content}));
        }
        input.push(json!({"role":"user","content":"<environment_context>\n<cwd>/home/user/workspace</cwd>\n<shell>bash</shell>\n<timezone>Etc/UTC</timezone>\n</environment_context>"}));
        input.push(json!({"role":"user","content":p.prompt}));
        body["input"] = json!(input);
        body["tools"] = context["tools"].clone();
        body["text"] = json!({"verbosity":"low"});
    }
    if !req.effort.is_empty() {
        body["reasoning"] = json!({"effort":req.effort});
    }
    let metadata = ModelExecuteRequest {
        client_key_id: Some(req.client_key_id.clone()),
        provider: Some("openai".into()),
        account_id: Some(req.account_id.clone()),
        model: req.model.clone(),
        protocol: "openai".into(),
        operation: ModelOperation::Generate,
        previous_response_id: None,
    };
    // 150 秒先于宿主页面的 180 秒超时，预留终态保存与回传时间。
    let reply: Result<(ModelExecuteResult, Vec<u8>), PluginFault> = tokio::select! {
        biased;
        _=call.cancellation.cancelled()=>return Err((None,"cancelled")),
        _=cancel.changed()=>return Err((None,"cancelled")),
        _=tokio::time::sleep(Duration::from_secs(150))=>return Err((None,"timeout")),
        result=history::callback(&call.host,"host.model.execute",metadata,serde_json::to_vec(&body).map_err(|_|(None,"invalid_request"))?)=>result,
    };
    let (meta, payload) = reply.map_err(|error| {
        (
            None,
            match error.code {
                ErrorCode::PermissionDenied | ErrorCode::Rejected => "permission_denied",
                ErrorCode::Timeout => "timeout",
                ErrorCode::Capacity => "capacity",
                ErrorCode::Cancelled => "cancelled",
                _ => "execution_failed",
            },
        )
    })?;
    let answer =
        model::decode(&payload).map_err(|reason| (Some(meta.request_id.clone()), reason))?;
    Ok((meta.request_id, answer))
}

pub async fn run(
    state: Arc<AppState>,
    call: &TypedCall<ManagementRequest>,
    req: RunRequest,
    mut cancel: watch::Receiver<bool>,
) -> Result<Value, PluginFault> {
    let started = Instant::now();
    let mut record = match history::find(&call.host, &req.id).await? {
        Some(mut record) => {
            for (key, value) in [
                ("accountId", &req.account_id),
                ("clientKeyId", &req.client_key_id),
                ("model", &req.model),
                ("effort", &req.effort),
                ("kind", &req.kind),
            ] {
                if record[key] != value.as_str() {
                    return Err(conflict());
                }
            }
            if record["requestProfile"].as_str().unwrap_or("simple-v1") != req.profile {
                return Err(conflict());
            }
            // 已记录的终态直接返回，重复提交不会再次消费模型额度。
            if !matches!(record["status"].as_str(), Some("running" | "partial")) {
                return Ok(json!({"record":record,"persisted":true,"nextStep":Value::Null}));
            }
            if !record["pendingStep"].is_null() {
                record["status"] = json!("interrupted");
                record["pendingStep"] = Value::Null;
                record["remaining"] = json!([]);
                history::append(&call.host, record.clone()).await?;
                return Ok(json!({"record":record,"persisted":true,"nextStep":Value::Null}));
            }
            record
        }
        None => {
            if req.step != 0 {
                return Err(conflict());
            }
            let source: Value = serde_json::from_slice(include_bytes!("../../vendor/SOURCES.json"))
                .map_err(|_| history::invalid())?;
            json!({"id":req.id,"accountId":req.account_id,"actualAccountId":Value::Null,"clientKeyId":req.client_key_id,"model":req.model,"effort":req.effort,"kind":req.kind,"status":"partial","startedAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),"durationMs":0,"samples":[],"remaining":plan(&req.kind)?,"pendingStep":Value::Null,"expectedSamples":if req.kind=="fingerprint"{3}else{1},"attribution":Value::Null,"detectorVersion":state.detector.built_at(),"detectorRevision":source["detectorRevision"],"requestContextSha256":if req.profile=="codex-context-v1" {source["files"]["data/codex-context.json"].clone()} else {Value::Null},"requestProfile":req.profile,"gradingAnswer":if req.kind=="candy"{Some(21)}else{None},"pluginVersion":env!("CARGO_PKG_VERSION"),"upstreamAttempts":Value::Null})
        }
    };
    let count = record["samples"]
        .as_array()
        .ok_or_else(history::invalid)?
        .len();
    if usize::from(req.step) != count {
        return Err(conflict());
    }
    let planned: Planned = serde_json::from_value(
        record["remaining"]
            .as_array()
            .and_then(|p| p.first())
            .cloned()
            .ok_or_else(history::invalid)?,
    )
    .map_err(|_| history::invalid())?;
    record["status"] = json!("running");
    record["pendingStep"] = json!(req.step);
    // 先落执行意图再发请求，中断后保留已完成样本，不推测上游是否消费。
    history::append(&call.host, record.clone()).await?;
    let result = ask(call, &req, &planned, &mut cancel).await;
    let (status, request_id, answer) = match result {
        Ok((id, a)) => ("completed", Some(id), Some(a)),
        Err((id, s)) => (s, id, None),
    };
    let sample = Sample {
        prompt: planned.prompt,
        instructions: planned.instructions,
        expected_count: planned.expected_count,
        request_id,
        status: status.into(),
        answer,
        duration_ms: started.elapsed().as_millis() as u64,
    };
    record["samples"]
        .as_array_mut()
        .ok_or_else(history::invalid)?
        .push(serde_json::to_value(sample).map_err(|_| history::invalid())?);
    record["remaining"]
        .as_array_mut()
        .ok_or_else(history::invalid)?
        .remove(0);
    record["pendingStep"] = Value::Null;
    record["durationMs"] = json!(
        record["durationMs"].as_u64().unwrap_or_default() + started.elapsed().as_millis() as u64
    );
    let mut next_step = None;
    if status != "completed" {
        record["status"] = json!(if status == "cancelled" {
            "cancelled"
        } else {
            "failed"
        });
        record["remaining"] = json!([]);
    } else if req.kind == "fingerprint" && count < 2 {
        record["status"] = json!("partial");
        next_step = Some(count + 1);
    } else if req.kind == "candy" {
        record["status"] = json!(if prompts::has_answer(
            record["samples"][0]["answer"]["text"]
                .as_str()
                .unwrap_or_default()
        ) {
            "correct"
        } else {
            "wrong"
        });
    } else if req.kind == "fingerprint" {
        let outputs: Vec<lmfpd::Output> = record["samples"]
            .as_array()
            .ok_or_else(history::invalid)?
            .iter()
            .map(|s| lmfpd::Output {
                text: s["answer"]["text"].as_str().unwrap_or_default().into(),
                expected_count: s["expectedCount"].as_u64().unwrap_or_default(),
            })
            .collect();
        record["status"] = json!("unscorable");
        if let Ok(analysis) = state.detector.analyze(&outputs, true) {
            if !analysis.results.is_empty() {
                record["status"] = json!("completed");
            }
            record["attribution"] =
                serde_json::to_value(analysis).map_err(|_| history::invalid())?;
        }
    } else {
        record["status"] = json!("completed");
    }
    let persisted = history::append(&call.host, record.clone()).await.is_ok();
    Ok(json!({"record":record,"persisted":persisted,"nextStep":if persisted{next_step}else{None}}))
}
