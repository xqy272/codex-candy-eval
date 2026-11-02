//! 注册管理页面与测试接口，活动任务通过作用域守卫释放
use crate::{
    evaluation::{self, RunRequest},
    history,
};
use gateway_plugin_sdk::{
    ErrorCode, PluginFault,
    call::{
        data::AccountFactsQuery,
        host::{KeyListRequest, ModelListRequest},
        management::*,
    },
    client::{TypedCall, TypedReply},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

pub struct AppState {
    pub detector: lmfpd::Detector,
    pub(crate) active: Mutex<Option<Active>>,
    pub(crate) admission: tokio::sync::Mutex<()>,
}
pub(crate) struct Active {
    pub(crate) id: String,
    pub(crate) cancel: watch::Sender<bool>,
}
impl AppState {
    pub fn new(detector: lmfpd::Detector) -> Self {
        Self {
            detector,
            active: Mutex::new(None),
            admission: tokio::sync::Mutex::new(()),
        }
    }
}
pub(crate) struct ActiveGuard(pub(crate) Arc<AppState>);
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active = None;
        }
    }
}

pub fn registration() -> ManagementRegistration {
    let route = |method: &str, path: &str| ManagementRoute {
        method: method.into(),
        path: path.into(),
        request_content_types: if method == "POST" {
            vec!["application/json".into()]
        } else {
            vec![]
        },
        response_content_types: vec!["application/json".into()],
    };
    ManagementRegistration {
        routes: vec![
            route("GET", "api/snapshot"),
            route("POST", "api/models"),
            route("GET", "api/history"),
            route("POST", "api/run"),
            route("POST", "api/cancel"),
            route("POST", "api/clear"),
            route("POST", "api/detail"),
            route("GET", "api/tasks"),
            route("POST", "api/submit"),
            route("POST", "api/task"),
            route("POST", "api/sample"),
            route("POST", "api/resume"),
            route("POST", "api/stop"),
            route("POST", "api/delete"),
        ],
        resources: ["web/index.html", "web/app.js", "web/app.css"]
            .into_iter()
            .map(|p| ManagementResource {
                path: p.into(),
                public: false,
            })
            .collect(),
        pages: vec![ManagementPage {
            id: "codex-candy-eval".into(),
            title: "Codex 账号测试".into(),
            description: Some("糖果题、模型指纹与画鹈鹕".into()),
            entry: "web/index.html".into(),
            icon: None,
        }],
        callbacks: vec![],
    }
}
fn fault(code: ErrorCode, message: &str) -> PluginFault {
    PluginFault::new(code, message)
}
fn reply(status: u16, value: Value) -> Result<TypedReply<ManagementResponse>, PluginFault> {
    Ok(TypedReply::new(ManagementResponse {
        status,
        content_type: "application/json".into(),
        headers: vec![],
    })
    .with_payload(serde_json::to_vec(&value).map_err(|_| history::invalid())?))
}
fn body<T: serde::de::DeserializeOwned>(
    call: &TypedCall<ManagementRequest>,
) -> Result<T, PluginFault> {
    if call.payload.len() > 8192
        || call
            .request
            .content_type
            .as_deref()
            .and_then(|s| s.split(';').next())
            .map(str::trim)
            != Some("application/json")
    {
        return Err(fault(ErrorCode::InvalidInput, "请求正文格式或长度无效"));
    }
    serde_json::from_slice(&call.payload)
        .map_err(|_| fault(ErrorCode::InvalidInput, "请求字段无效"))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyRequest {
    client_key_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClearRequest {
    account_id: Option<String>,
    kind: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelRequest {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SampleRequest {
    id: String,
    key: String,
}

pub async fn handle(
    state: Arc<AppState>,
    call: TypedCall<ManagementRequest>,
) -> Result<TypedReply<ManagementResponse>, PluginFault> {
    let result = dispatch(state, &call).await;
    match result {
        Ok(value) => reply(200, value),
        Err(error) => {
            // 展示本插件固定提示，不将宿主内部错误正文或请求头写入页面
            let (status, message) = match error.code {
                ErrorCode::InvalidInput => (400, "请求字段或正文无效"),
                ErrorCode::Conflict | ErrorCode::Capacity => {
                    (409, "已有测试正在运行或记录发生冲突")
                }
                ErrorCode::Cancelled => (409, "测试已取消"),
                ErrorCode::PermissionDenied | ErrorCode::Rejected => {
                    (403, "所选 Key 或账号无法执行此操作")
                }
                _ => (502, "操作未完成，请检查 CPR 中对应请求的错误记录"),
            };
            reply(
                status,
                json!({"error":{"code":error.code,"message":message}}),
            )
        }
    }
}
async fn dispatch(
    state: Arc<AppState>,
    call: &TypedCall<ManagementRequest>,
) -> Result<Value, PluginFault> {
    if !call.request.query.is_empty() {
        return Err(fault(ErrorCode::InvalidInput, "不支持查询参数"));
    }
    if call.request.method == "GET"
        && (!call.payload.is_empty() || call.request.content_type.is_some())
    {
        return Err(fault(ErrorCode::InvalidInput, "读取接口不能带正文"));
    }
    match (call.request.method.as_str(), call.request.path.as_str()) {
        ("GET", "api/tasks") => crate::jobs::list(&call.host).await,
        ("POST", "api/submit") => crate::jobs::submit(&state, &call.host, body(call)?).await,
        ("POST", "api/task") => {
            let req: CancelRequest = body(call)?;
            crate::jobs::report(&call.host, &req.id).await
        }
        ("POST", "api/sample") => {
            let req: SampleRequest = body(call)?;
            crate::jobs::sample(&call.host, &req.id, &req.key).await
        }
        ("POST", "api/resume" | "api/stop" | "api/delete") => {
            let req: CancelRequest = body(call)?;
            crate::jobs::action(&state, &call.host, &req.id, &call.request.path).await
        }
        ("GET", "api/snapshot") => {
            let mut accounts = Vec::new();
            let mut cursor = None;
            loop {
                let page = call
                    .host
                    .account_facts(AccountFactsQuery {
                        provider_id: Some("openai".into()),
                        cursor: cursor.clone(),
                        limit: 200,
                    })
                    .await?;
                accounts.extend(page.accounts);
                if page.next_cursor.is_none() {
                    break;
                }
                if page.next_cursor == cursor || accounts.len() > 10_000 {
                    return Err(history::invalid());
                }
                cursor = page.next_cursor;
            }
            let mut keys = Vec::new();
            let mut cursor = None;
            loop {
                let page = call
                    .host
                    .list_keys(KeyListRequest {
                        cursor: cursor.clone(),
                        limit: 200,
                    })
                    .await?;
                keys.extend(page.keys);
                if page.next_cursor.is_none() {
                    break;
                }
                if page.next_cursor == cursor || keys.len() > 10_000 {
                    return Err(history::invalid());
                }
                cursor = page.next_cursor;
            }
            let active = state
                .active
                .lock()
                .map_err(|_| history::invalid())?
                .as_ref()
                .map(|a| a.id.clone());
            Ok(
                json!({"accounts":accounts,"keys":keys,"detectorVersion":state.detector.built_at(),"activeId":active}),
            )
        }
        ("POST", "api/models") => {
            let req: KeyRequest = body(call)?;
            if req.client_key_id.trim().is_empty() || req.client_key_id.len() > 128 {
                return Err(fault(ErrorCode::InvalidInput, "请选择 Key"));
            }
            let (models, _): (gateway_plugin_sdk::call::host::ModelListResult, _) =
                history::callback(
                    &call.host,
                    "host.models.list",
                    ModelListRequest {
                        client_key_id: req.client_key_id,
                        protocol: "openai".into(),
                        client_version: format!("codex-candy-eval/{}", env!("CARGO_PKG_VERSION")),
                    },
                    vec![],
                )
                .await?;
            Ok(json!(models))
        }
        ("GET", "api/history") => {
            let saved = history::load(&call.host).await?;
            let mut value = saved
                .record
                .map(|r| r.value)
                .unwrap_or_else(|| json!({"records":[]}));
            let active = state
                .active
                .lock()
                .map_err(|_| history::invalid())?
                .as_ref()
                .map(|a| a.id.clone());
            for record in value["records"]
                .as_array_mut()
                .ok_or_else(history::invalid)?
            {
                if record["status"] == "running" && record["id"].as_str() != active.as_deref() {
                    record["status"] = json!("interrupted");
                    if record["summaryOnly"] == true
                        && let Some(id) = record["id"].as_str()
                        && let Some(detail) = history::find(&call.host, id).await?
                        && detail["status"] != "running"
                    {
                        record["status"] = detail["status"].clone();
                    }
                }
            }
            Ok(value)
        }
        ("POST", "api/run") => {
            let req: RunRequest = body(call)?;
            if !req.valid() {
                return Err(fault(ErrorCode::InvalidInput, "测试参数无效"));
            }
            let (tx, rx) = watch::channel(false);
            let admission = state.admission.lock().await;
            if crate::jobs::has_pending(&call.host).await? {
                return Err(fault(ErrorCode::Conflict, "请先处理后台任务"));
            }
            {
                let mut active = state.active.lock().map_err(|_| history::invalid())?;
                if active.is_some() {
                    return Err(fault(ErrorCode::Conflict, "已有测试运行"));
                }
                *active = Some(Active {
                    id: req.id.clone(),
                    cancel: tx,
                });
            }
            drop(admission);
            let _guard = ActiveGuard(Arc::clone(&state));
            evaluation::run(state, call, req, rx).await
        }
        ("POST", "api/detail") => {
            let req: CancelRequest = body(call)?;
            if req.id.is_empty() || req.id.len() > 128 || req.id.chars().any(char::is_control) {
                return Err(fault(ErrorCode::InvalidInput, "记录 ID 无效"));
            }
            let mut record = history::find(&call.host, &req.id).await?;
            let active = state
                .active
                .lock()
                .map_err(|_| history::invalid())?
                .as_ref()
                .is_some_and(|a| a.id == req.id);
            if !active
                && let Some(r) = record.as_mut()
                && r["status"] == "running"
            {
                r["status"] = json!("interrupted");
            }
            Ok(json!({"record":record}))
        }
        ("POST", "api/clear") => {
            let req: ClearRequest = body(call)?;
            let _admission = state.admission.lock().await;
            if state
                .active
                .lock()
                .map_err(|_| history::invalid())?
                .is_some()
            {
                return Err(fault(ErrorCode::Conflict, "测试期间不能清理历史"));
            }
            let saved = history::load(&call.host).await?;
            if let Some(record) = saved.record {
                let mut value = record.value;
                let old = value["records"]
                    .as_array()
                    .cloned()
                    .ok_or_else(history::invalid)?;
                value["records"]
                    .as_array_mut()
                    .ok_or_else(history::invalid)?
                    .retain(|r| {
                        !(req
                            .account_id
                            .as_ref()
                            .is_none_or(|id| r["accountId"] == id.as_str())
                            && req
                                .kind
                                .as_ref()
                                .is_none_or(|kind| r["kind"] == kind.as_str()))
                    });
                let _: (gateway_plugin_sdk::call::host::StatePutResult, _) = history::callback(
                    &call.host,
                    "host.state.put",
                    gateway_plugin_sdk::call::host::StatePutRequest {
                        namespace: "history".into(),
                        key: "records".into(),
                        expected_version: Some(record.version),
                        value: value.clone(),
                    },
                    vec![],
                )
                .await?;
                let kept = value["records"].as_array().ok_or_else(history::invalid)?;
                let removed: Vec<Value> = old
                    .into_iter()
                    .filter(|r| !kept.iter().any(|k| k["id"] == r["id"]))
                    .collect();
                history::remove_details(&call.host, &removed).await?;
            }
            Ok(json!({"cleared":true}))
        }
        ("POST", "api/cancel") => {
            let req: CancelRequest = body(call)?;
            // 未执行题目的取消落盘与新调用的启动互斥，防止取消后又发起下一题。
            let _admission = state.admission.lock().await;
            let matched = {
                let active = state.active.lock().map_err(|_| history::invalid())?;
                if active.as_ref().is_some_and(|a| a.id != req.id) {
                    return Ok(json!({"cancelled":false}));
                }
                let matched = active.as_ref().filter(|a| a.id == req.id);
                if let Some(a) = matched {
                    a.cancel.send_replace(true);
                }
                matched.is_some()
            };
            if matched {
                return Ok(json!({"cancelled":true}));
            }
            if let Some(mut record) = history::find(&call.host, &req.id).await?
                && matches!(record["status"].as_str(), Some("partial" | "running"))
            {
                record["status"] = json!("cancelled");
                record["pendingStep"] = Value::Null;
                record["remaining"] = json!([]);
                history::append(&call.host, record.clone()).await?;
                return Ok(json!({"cancelled":true,"record":record}));
            }
            Ok(json!({"cancelled":false}))
        }
        _ => Err(fault(ErrorCode::InvalidInput, "未知操作")),
    }
}
