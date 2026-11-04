//! 用真实 SDK 双工协议模拟宿主，不访问账号、不发送模型请求
use gateway_plugin_sdk::{
    CallContext, Frame, Handshake, Manifest, Message, PROTOCOL_VERSION, Stage,
    call::{
        host::ModelEventBatch,
        model::{CanonicalEvent, ExecutionEvent, FinishReason},
    },
    client::{PluginSession, SessionConfig, read_frame, write_frame},
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::{
    io::{DuplexStream, ReadHalf, WriteHalf},
    task::JoinHandle,
};

struct Host {
    reader: ReadHalf<DuplexStream>,
    writer: WriteHalf<DuplexStream>,
    task: JoinHandle<()>,
    saved: Option<Value>,
    jobs: std::collections::HashMap<String, (Value, u64)>,
    identity: String,
    credential_revision: u64,
    fail_task_save: bool,
    fail_create_task: bool,
    fail_create_batch: bool,
    failure_after: Option<usize>,
    details: std::collections::HashMap<String, (Value, u64)>,
    version: u64,
    executes: usize,
    fail_stream: bool,
    consumed: Vec<u64>,
}
impl Host {
    async fn start() -> Self {
        let manifest = Manifest::from_author_slice(include_bytes!("../../plugin.json")).unwrap();
        let handler =
            cpr_candy_eval::plugin(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../data")).unwrap();
        let (host, plugin) = tokio::io::duplex(256 * 1024);
        let (reader, writer) = tokio::io::split(plugin);
        let task = tokio::spawn(async move {
            let mut session = PluginSession::accept(reader, writer, SessionConfig::default())
                .await
                .unwrap();
            session
                .set_call_budgets(gateway_plugin_sdk::CallBudgets::from([
                    (Stage::Management, 600_000),
                    (Stage::Maintenance, 630_000),
                ]))
                .unwrap();
            session.run(handler).await.unwrap();
        });
        let (reader, writer) = tokio::io::split(host);
        let mut this = Self {
            reader,
            writer,
            task,
            saved: None,
            jobs: Default::default(),
            identity: "user-test".into(),
            credential_revision: 1,
            fail_task_save: false,
            fail_create_task: false,
            fail_create_batch: false,
            failure_after: None,
            details: Default::default(),
            version: 0,
            executes: 0,
            fail_stream: false,
            consumed: vec![],
        };
        this.send(Frame::control(Message::Hello {
            handshake: Handshake {
                protocol_version: PROTOCOL_VERSION,
                artifact_sha256: "a".repeat(64),
                plugin_id: manifest.plugin_id().unwrap(),
                instance_id: "test".into(),
                generation: 1,
                incarnation: "test".into(),
                configuration: json!({}),
                contributes: manifest.contributes,
            },
        }))
        .await;
        assert!(matches!(this.next().await.message, Message::Ready { .. }));
        this
    }
    async fn detail_callback(&mut self, id: u64, method: &str, params: &Value, save: bool) {
        let key = params["key"].as_str().unwrap().to_owned();
        match method {
            "host.state.get" => {
                let record = self.details.get(&key).map(
                    |(value, version)| json!({"value":value,"version":version,"schema_version":1}),
                );
                self.reply(id, json!({"record":record}), vec![]).await;
            }
            "host.state.put" => {
                let old = self.details.get(&key).map(|(_, v)| *v);
                assert_eq!(params["expected_version"], json!(old));
                if save || params["value"]["record"]["pendingStep"].is_number() {
                    let version = old.unwrap_or(0) + 1;
                    self.details.insert(key, (params["value"].clone(), version));
                    self.reply(id, json!({"version":version}), vec![]).await;
                } else {
                    self.send(Frame::control(Message::Error {
                        id,
                        error: gateway_plugin_sdk::PluginFault::new(
                            gateway_plugin_sdk::ErrorCode::Conflict,
                            "mock save failure",
                        ),
                    }))
                    .await;
                }
            }
            "host.state.delete" => {
                self.details.remove(&key);
                self.reply(id, json!({"deleted":true}), vec![]).await;
            }
            _ => panic!("Unexpected detail callback"),
        }
    }
    async fn send(&mut self, frame: Frame) {
        write_frame(&mut self.writer, &frame).await.unwrap();
    }
    async fn next(&mut self) -> Frame {
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(5), read_frame(&mut self.reader))
                .await
                .unwrap()
                .unwrap();
            match frame.message {
                Message::Suspend { .. } => continue,
                Message::CallbackConsumed { id, .. } => self.consumed.push(id),
                Message::Resume { id, epoch } => {
                    self.send(Frame::control(Message::Resumed { id, epoch }))
                        .await
                }
                _ => return frame,
            }
        }
    }
    async fn call(&mut self, id: u64, path: &str, data: Option<Value>) {
        self.send(Frame { message: Message::Call { id, method: "management.handle".into(), context: CallContext {
            request: None, call_id: id, instance_id: "test".into(), generation: 1, incarnation: "test".into(), stage: Stage::Management, timeout_ms: 600_000, resource_stream: false, resource_scope_id: format!("scope-{id}"), request_id: None, attempt_id: None, account_id: None, credential_revision: None,
        }, params: json!({"method":if data.is_some(){"POST"}else{"GET"},"path":path,"query":"","content_type":data.as_ref().map(|_|"application/json"),"headers":[]}) }, payload: data.map(|v|serde_json::to_vec(&v).unwrap()).unwrap_or_default() }).await;
    }

    async fn maintenance(&mut self, id: u64, timeout_ms: u64) {
        self.send(Frame {
            message: Message::Call {
                id,
                method: "plugin.reconcile".into(),
                context: CallContext {
                    request: None,
                    call_id: id,
                    instance_id: "test".into(),
                    generation: 1,
                    incarnation: "test".into(),
                    stage: Stage::Maintenance,
                    timeout_ms,
                    resource_stream: false,
                    resource_scope_id: format!("scope-{id}"),
                    request_id: None,
                    attempt_id: None,
                    account_id: None,
                    credential_revision: None,
                },
                params: json!({}),
            },
            payload: vec![],
        })
        .await;
    }
    async fn reply(&mut self, id: u64, result: Value, payload: Vec<u8>) {
        self.send(Frame {
            message: Message::Result { id, result },
            payload,
        })
        .await;
    }
    async fn result(
        &mut self,
        expected: u64,
        answer: &str,
        complete: bool,
        save: bool,
    ) -> (u64, Value) {
        loop {
            let frame = self.next().await;
            match frame.message {
                Message::Result { id, result } => {
                    assert_eq!(id, expected);
                    return (
                        result["status"].as_u64().unwrap_or(0),
                        if frame.payload.is_empty() {
                            result.clone()
                        } else {
                            serde_json::from_slice(&frame.payload).unwrap()
                        },
                    );
                }
                Message::Callback {
                    id, method, params, ..
                } => match method.as_str() {
                    "host.auth.get_runtime" => {
                        let runtime = json!({"account_id":"account-test","provider_id":"openai","credential_revision":self.credential_revision,"name":"Test account","email":null,"upstream_user_id":self.identity,"upstream_account_id":"org-test","plan_type":null,"authentication_kind":"oauth","enabled":true,"credential_state":"ready","has_refresh_token":false,"access_token_expires_at_ms":null,"next_refresh_at_ms":null});
                        self.reply(id, json!({}), serde_json::to_vec(&runtime).unwrap())
                            .await;
                    }
                    "host.state.get" | "host.state.put" | "host.state.delete"
                        if ["queue", "tasks", "samples", "batches"]
                            .iter()
                            .any(|ns| params["namespace"] == *ns) =>
                    {
                        let key = format!(
                            "{}/{}",
                            params["namespace"].as_str().unwrap(),
                            params["key"].as_str().unwrap()
                        );
                        match method.as_str() {
                            "host.state.get" => {
                                let value = self.jobs.get(&key).map(
                                    |(v, n)| json!({"value":v,"version":n,"schema_version":1}),
                                );
                                self.reply(id, json!({"record":value}), vec![]).await;
                            }
                            "host.state.put" => {
                                if (params["namespace"] == "batches"
                                    && self.fail_create_batch
                                    && params["key"] != "index"
                                    && params["key"] != "settings")
                                    || params["namespace"] == "tasks"
                                        && (self.fail_create_task
                                            || self.fail_task_save
                                                && params["value"]["status"] != "running"
                                                && self.jobs.contains_key(&key))
                                {
                                    self.fail_create_batch = false;
                                    self.fail_create_task = false;
                                    self.fail_task_save = false;
                                    self.send(Frame::control(Message::Error {
                                        id,
                                        error: gateway_plugin_sdk::PluginFault::new(
                                            gateway_plugin_sdk::ErrorCode::Conflict,
                                            "simulated lost task commit",
                                        ),
                                    }))
                                    .await;
                                } else {
                                    let old = self.jobs.get(&key).map(|(_, v)| *v);
                                    assert_eq!(params["expected_version"], json!(old));
                                    let version = old.unwrap_or(0) + 1;
                                    self.jobs.insert(key, (params["value"].clone(), version));
                                    self.reply(id, json!({"version":version}), vec![]).await;
                                }
                            }
                            _ => {
                                self.jobs.remove(&key);
                                self.reply(id, json!({"deleted":true}), vec![]).await;
                            }
                        }
                    }
                    "host.state.get" | "host.state.put" | "host.state.delete"
                        if params["namespace"] == "details" =>
                    {
                        self.detail_callback(id, &method, &params, save).await
                    }
                    "host.model.execute_stream" => {
                        self.executes += 1;
                        assert_eq!(params["account_id"], "account-test");
                        assert_eq!(params["client_key_id"], "key-test");
                        assert_eq!(params["provider"], "openai");
                        let body: Value = serde_json::from_slice(&frame.payload).unwrap();
                        assert_eq!(body["store"], false);
                        assert_eq!(body["tool_choice"], "none");
                        if !body["tools"].as_array().unwrap().is_empty() {
                            assert!(body["instructions"].as_str().unwrap().len() > 20000);
                            assert!(body["input"].as_array().unwrap().len() > 3);
                        }
                        assert!(body["instructions"].is_string());
                        self.reply(
                            id,
                            json!({"request_id":"request-test","stream":"stream-test"}),
                            vec![],
                        )
                        .await;
                    }
                    "host.model.stream_close" => {
                        self.reply(id, json!({"closed":true}), vec![]).await;
                    }
                    "host.model.stream_read"
                        if self.fail_stream
                            || self.failure_after.is_some_and(|n| self.executes >= n) =>
                    {
                        let mut error = gateway_plugin_sdk::PluginFault::new(
                            gateway_plugin_sdk::ErrorCode::Capacity,
                            "not shown",
                        );
                        error.details = Some(
                            json!({"kind":"concurrency_queue_timeout","raw_secret":"must never persist"}),
                        );
                        self.send(Frame::control(Message::Error { id, error }))
                            .await;
                    }
                    "host.model.stream_read" => {
                        let mut events =
                            vec![ExecutionEvent::canonical(CanonicalEvent::TextDelta {
                                index: 0,
                                text: answer.into(),
                            })];
                        if complete {
                            events.push(ExecutionEvent::canonical(CanonicalEvent::Completed {
                                id: "response-test".into(),
                                model: None,
                                reason: FinishReason::Stop,
                            }));
                        }
                        let count = events.len();
                        self.reply(
                            id,
                            json!({"events":count,"end":true}),
                            ModelEventBatch { events }.encode().unwrap(),
                        )
                        .await;
                    }
                    "host.state.get" => {
                        let record = self
                            .saved
                            .as_ref()
                            .map(|v| json!({"value":v,"version":self.version,"schema_version":1}));
                        self.reply(id, json!({"record":record}), vec![]).await;
                    }
                    "host.state.put" => {
                        assert_eq!(
                            params["expected_version"],
                            if self.version == 0 {
                                Value::Null
                            } else {
                                json!(self.version)
                            }
                        );
                        assert!(params["value"]["records"].as_array().unwrap().len() <= 20);
                        if save
                            || params["value"]["records"]
                                .get(0)
                                .is_some_and(|r| r["pendingStep"].is_number())
                        {
                            self.version += 1;
                            self.saved = Some(params["value"].clone());
                            self.reply(id, json!({"version":self.version}), vec![])
                                .await;
                        } else {
                            self.send(Frame::control(Message::Error {
                                id,
                                error: gateway_plugin_sdk::PluginFault::new(
                                    gateway_plugin_sdk::ErrorCode::Conflict,
                                    "mock conflict",
                                ),
                            }))
                            .await;
                        }
                    }
                    _ => panic!("unexpected callback: {method}"),
                },
                Message::Error { id, .. } if id == expected => return (500, Value::Null),
                other => panic!("unexpected frame: {other:?}"),
            }
        }
    }
    async fn pending_model(&mut self) -> u64 {
        loop {
            let frame = self.next().await;
            match frame.message {
                Message::Callback {
                    id, method, params, ..
                } => match method.as_str() {
                    "host.auth.get_runtime" => {
                        let runtime = json!({"account_id":"account-test","provider_id":"openai","credential_revision":self.credential_revision,"name":"Test account","email":null,"upstream_user_id":self.identity,"upstream_account_id":"org-test","plan_type":null,"authentication_kind":"oauth","enabled":true,"credential_state":"ready","has_refresh_token":false,"access_token_expires_at_ms":null,"next_refresh_at_ms":null});
                        self.reply(id, json!({}), serde_json::to_vec(&runtime).unwrap())
                            .await;
                    }
                    "host.state.get" | "host.state.put" | "host.state.delete"
                        if ["queue", "tasks", "samples", "batches"]
                            .iter()
                            .any(|ns| params["namespace"] == *ns) =>
                    {
                        let key = format!(
                            "{}/{}",
                            params["namespace"].as_str().unwrap(),
                            params["key"].as_str().unwrap()
                        );
                        match method.as_str() {
                            "host.state.get" => {
                                let value = self.jobs.get(&key).map(
                                    |(v, n)| json!({"value":v,"version":n,"schema_version":1}),
                                );
                                self.reply(id, json!({"record":value}), vec![]).await;
                            }
                            "host.state.put" => {
                                if params["namespace"] == "tasks"
                                    && (self.fail_create_task
                                        || self.fail_task_save
                                            && params["value"]["status"] != "running"
                                            && self.jobs.contains_key(&key))
                                {
                                    self.fail_create_task = false;
                                    self.fail_task_save = false;
                                    self.send(Frame::control(Message::Error {
                                        id,
                                        error: gateway_plugin_sdk::PluginFault::new(
                                            gateway_plugin_sdk::ErrorCode::Conflict,
                                            "simulated lost task commit",
                                        ),
                                    }))
                                    .await;
                                } else {
                                    let old = self.jobs.get(&key).map(|(_, v)| *v);
                                    assert_eq!(params["expected_version"], json!(old));
                                    let version = old.unwrap_or(0) + 1;
                                    self.jobs.insert(key, (params["value"].clone(), version));
                                    self.reply(id, json!({"version":version}), vec![]).await;
                                }
                            }
                            _ => {
                                self.jobs.remove(&key);
                                self.reply(id, json!({"deleted":true}), vec![]).await;
                            }
                        }
                    }
                    "host.state.get" | "host.state.put" | "host.state.delete"
                        if params["namespace"] == "details" =>
                    {
                        self.detail_callback(id, &method, &params, true).await
                    }
                    "host.state.get" => {
                        let record = self
                            .saved
                            .as_ref()
                            .map(|v| json!({"value":v,"version":self.version,"schema_version":1}));
                        self.reply(id, json!({"record":record}), vec![]).await;
                    }
                    "host.state.put" => {
                        self.version += 1;
                        self.saved = Some(params["value"].clone());
                        self.reply(id, json!({"version":self.version}), vec![])
                            .await;
                    }
                    "host.model.execute_stream" => return id,
                    _ => panic!("unexpected callback {method}"),
                },
                other => panic!("unexpected frame {other:?}"),
            }
        }
    }
    async fn shutdown(mut self) {
        self.send(Frame::control(Message::Shutdown)).await;
        tokio::time::timeout(Duration::from_secs(2), self.task)
            .await
            .unwrap()
            .unwrap();
    }
}
fn run(id: &str, kind: &str) -> Value {
    json!({"id":id,"accountId":"account-test","clientKeyId":"key-test","model":"gpt-test","effort":"high","kind":kind})
}

#[tokio::test]
async fn candy_pins_account_preserves_history_and_flags_save_failure() {
    let mut host = Host::start().await;
    for (id, answer, complete, status, save) in [
        (1, "21", true, "correct", true),
        (3, "29", true, "wrong", true),
        (5, "21", false, "failed", true),
        (7, "21", true, "correct", false),
    ] {
        host.call(id, "api/run", Some(run(&format!("run-{id}"), "candy")))
            .await;
        let (http, value) = host.result(id, answer, complete, save).await;
        assert_eq!(http, 200);
        assert_eq!(value["record"]["status"], status);
        assert_eq!(value["persisted"], save);
        assert!(value["record"]["upstreamAttempts"].is_null());
    }
    assert_eq!(
        host.saved.as_ref().unwrap()["records"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert_eq!(host.executes, 4);
    host.shutdown().await;
}
#[tokio::test]
async fn fingerprint_requires_three_complete_numeric_samples() {
    let mut host = Host::start().await;
    let mut value = Value::Null;
    for step in 0..3 {
        let mut request = run("fp", "fingerprint");
        request["step"] = json!(step);
        host.call(step * 2 + 1, "api/run", Some(request)).await;
        value = host.result(step * 2 + 1, "21", true, true).await.1;
        if step < 2 {
            assert_eq!(value["record"]["status"], "partial");
            assert_eq!(value["nextStep"], step + 1);
        }
    }
    assert_eq!(host.executes, 3);
    assert_eq!(value["record"]["status"], "unscorable");
    assert_eq!(value["record"]["samples"].as_array().unwrap().len(), 3);
    host.shutdown().await;
}
#[tokio::test]
async fn cancellation_stops_the_callback_and_releases_the_run_slot() {
    let mut host = Host::start().await;
    host.call(1, "api/run", Some(run("cancel-me", "fingerprint")))
        .await;
    let callback_id = host.pending_model().await;
    host.call(3, "api/run", Some(run("duplicate", "candy")))
        .await;
    let (http, _) = host.result(3, "", false, true).await;
    assert_eq!(http, 409);
    host.call(5, "api/cancel", Some(json!({"id":"cancel-me"})))
        .await;
    let cancelled = host.result(5, "", false, true).await.1;
    let (_, value) = host.result(1, "", false, true).await;
    assert_eq!(value["record"]["status"], "cancelled");
    assert_eq!(value["record"]["samples"].as_array().unwrap().len(), 1);
    assert!(host.consumed.contains(&callback_id));
    assert_eq!(cancelled["cancelled"], true);
    host.call(7, "api/run", Some(run("after-cancel", "candy")))
        .await;
    assert_eq!(
        host.result(7, "21", true, true).await.1["record"]["status"],
        "correct"
    );
    host.shutdown().await;
}
#[tokio::test]
async fn rejects_unknown_fields_before_model_execution() {
    let mut host = Host::start().await;
    let mut input = run("invalid", "candy");
    input["apiKey"] = json!("must-not-be-accepted");
    host.call(1, "api/run", Some(input)).await;
    assert_eq!(host.result(1, "", false, true).await.0, 400);
    assert_eq!(host.executes, 0);
    host.shutdown().await;
}

#[tokio::test]
async fn timeout_releases_the_pending_callback() {
    let mut host = Host::start().await;
    tokio::time::pause();
    host.call(1, "api/run", Some(run("timeout", "candy"))).await;
    let callback_id = host.pending_model().await;
    tokio::time::advance(Duration::from_secs(151)).await;
    let (_, value) = host.result(1, "", false, true).await;
    assert_eq!(value["record"]["status"], "failed");
    assert_eq!(value["record"]["samples"][0]["status"], "timeout");
    assert_eq!(value["record"]["samples"][0]["error"]["origin"], "plugin");
    assert_eq!(value["record"]["samples"][0]["error"]["timeoutMs"], 150000);
    assert!(host.consumed.contains(&callback_id));
    host.shutdown().await;
}

#[tokio::test]
async fn drawing_survives_the_old_deadline_and_finishes_in_background() {
    let mut host = Host::start().await;
    tokio::time::pause();
    host.call(1, "api/submit", Some(run("long-drawing", "pelican")))
        .await;
    host.result(1, "", true, true).await;
    host.maintenance(3, 630000).await;
    let callback_id = host.pending_model().await;
    tokio::time::advance(Duration::from_secs(165)).await;
    host.reply(
        callback_id,
        json!({"request_id":"request-test","stream":"stream-test"}),
        vec![],
    )
    .await;
    assert_eq!(host.result(3, "<svg/>", true, true).await.0, 0);
    let job = &host.jobs["tasks/long-drawing"].0;
    assert_eq!(job["status"], "completed");
    assert_eq!(job["verdict"], "output");
    assert_eq!(job["attempts"].as_array().unwrap().len(), 1);
    assert_eq!(
        host.jobs["samples/long-drawing-0"].0["answer"]["text"],
        "<svg/>"
    );
    host.shutdown().await;
}

#[tokio::test]
async fn drawing_has_a_finite_deadline_and_does_not_automatically_retry() {
    let mut host = Host::start().await;
    tokio::time::pause();
    host.call(1, "api/submit", Some(run("drawing-timeout", "pelican")))
        .await;
    host.result(1, "", true, true).await;
    host.maintenance(3, 630000).await;
    let callback_id = host.pending_model().await;
    tokio::time::advance(Duration::from_secs(601)).await;
    host.result(3, "", false, true).await;
    assert_eq!(host.jobs["tasks/drawing-timeout"].0["status"], "paused");
    assert_eq!(host.jobs["tasks/drawing-timeout"].0["reason"], "timeout");
    assert_eq!(
        host.jobs["samples/drawing-timeout-0"].0["error"]["timeoutMs"],
        600000
    );
    assert!(host.consumed.contains(&callback_id));
    host.maintenance(5, 630000).await;
    host.result(5, "", true, true).await;
    assert_eq!(
        host.jobs["tasks/drawing-timeout"].0["attempts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    host.shutdown().await;
}

#[tokio::test]
async fn drawing_reserves_its_entire_window_before_sending() {
    let mut host = Host::start().await;
    host.call(1, "api/submit", Some(run("drawing-budget", "pelican")))
        .await;
    host.result(1, "", true, true).await;
    host.maintenance(3, 600000).await;
    host.result(3, "", true, true).await;
    assert_eq!(host.executes, 0);
    assert_eq!(host.jobs["tasks/drawing-budget"].0["status"], "queued");
    assert!(host.jobs["tasks/drawing-budget"].0["pending"].is_null());
    host.shutdown().await;
}

#[tokio::test]
async fn duplicate_completion_and_interrupted_checkpoint_do_not_reexecute() {
    let mut host = Host::start().await;
    let request = run("once", "candy");
    host.call(1, "api/run", Some(request.clone())).await;
    assert_eq!(
        host.result(1, "21", true, true).await.1["record"]["status"],
        "correct"
    );
    host.call(3, "api/run", Some(request)).await;
    assert_eq!(
        host.result(3, "29", true, true).await.1["record"]["status"],
        "correct"
    );
    assert_eq!(host.executes, 1);
    let mut partial = run("partial", "fingerprint");
    host.call(5, "api/run", Some(partial.clone())).await;
    assert_eq!(
        host.result(5, "21", true, true).await.1["record"]["status"],
        "partial"
    );
    host.saved.as_mut().unwrap()["records"][0]["status"] = json!("running");
    host.saved.as_mut().unwrap()["records"][0]["pendingStep"] = json!(1);
    if let Some((detail, _)) = host.details.get_mut("partial") {
        detail["record"]["status"] = json!("running");
        detail["record"]["pendingStep"] = json!(1);
    }
    partial["step"] = json!(1);
    host.call(7, "api/run", Some(partial)).await;
    assert_eq!(
        host.result(7, "21", true, true).await.1["record"]["status"],
        "interrupted"
    );
    assert_eq!(host.executes, 2);
    host.shutdown().await;
}

#[tokio::test]
async fn cancellation_between_samples_preserves_the_first_answer() {
    let mut host = Host::start().await;
    host.call(1, "api/run", Some(run("between", "fingerprint")))
        .await;
    assert_eq!(host.result(1, "21", true, true).await.1["nextStep"], 1);
    host.call(3, "api/cancel", Some(json!({"id":"between"})))
        .await;
    let cancelled = host.result(3, "", false, true).await.1;
    assert_eq!(cancelled["record"]["status"], "cancelled");
    assert_eq!(cancelled["record"]["samples"].as_array().unwrap().len(), 1);
    let mut next = run("between", "fingerprint");
    next["step"] = json!(1);
    host.call(5, "api/run", Some(next)).await;
    assert_eq!(
        host.result(5, "21", true, true).await.1["record"]["status"],
        "cancelled"
    );
    assert_eq!(host.executes, 1);
    host.shutdown().await;
}

#[tokio::test]
async fn context_profile_is_versioned_and_history_clear_is_scoped() {
    let mut host = Host::start().await;
    let mut req = run("profile", "candy");
    req["profile"] = json!("codex-context-v1");
    host.call(1, "api/run", Some(req.clone())).await;
    let result = host.result(1, "21", true, true).await.1;
    assert_eq!(result["record"]["requestProfile"], "codex-context-v1");
    req["profile"] = json!("simple-v1");
    host.call(3, "api/run", Some(req)).await;
    assert_eq!(host.result(3, "21", true, true).await.0, 409);
    assert_eq!(host.executes, 1);
    host.call(
        5,
        "api/clear",
        Some(json!({"account_id":"unrelated", "kind":null})),
    )
    .await;
    assert_eq!(host.result(5, "", false, true).await.0, 200);
    assert_eq!(
        host.saved.as_ref().unwrap()["records"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    host.call(
        7,
        "api/clear",
        Some(json!({"account_id":"account-test", "kind":"candy"})),
    )
    .await;
    assert_eq!(host.result(7, "", false, true).await.0, 200);
    assert!(
        host.saved.as_ref().unwrap()["records"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    host.shutdown().await;
}

#[tokio::test]
async fn legacy_inline_history_remains_readable_without_reexecution() {
    let mut host = Host::start().await;
    let req = run("legacy", "candy");
    let mut old = req.clone();
    old["status"] = json!("correct");
    old["samples"] = json!([{"answer":{"text":"21"}}]);
    host.saved = Some(json!({"records":[old]}));
    host.version = 1;
    host.call(1, "api/detail", Some(json!({"id":"legacy"})))
        .await;
    assert_eq!(
        host.result(1, "", false, true).await.1["record"]["samples"][0]["answer"]["text"],
        "21"
    );
    host.call(3, "api/run", Some(req)).await;
    assert_eq!(
        host.result(3, "", false, true).await.1["record"]["status"],
        "correct"
    );
    assert_eq!(host.executes, 0);
    host.shutdown().await;
}

#[tokio::test]
async fn stream_failure_preserves_request_id_and_safe_classification() {
    let mut host = Host::start().await;
    host.fail_stream = true;
    host.call(1, "api/run", Some(run("stream-failure", "fingerprint")))
        .await;
    let result = host.result(1, "", false, true).await.1;
    let sample = &result["record"]["samples"][0];
    assert_eq!(sample["requestId"], "request-test");
    assert_eq!(sample["status"], "queue_timeout");
    assert_eq!(sample["error"]["kind"], "concurrency_queue_timeout");
    assert!(!result.to_string().contains("must never persist"));
    assert!(result["nextStep"].is_null());
    host.shutdown().await;
}

#[tokio::test]
async fn background_submission_is_idempotent_and_budgeted() {
    let mut h = Host::start().await;
    let req = run("job-candy", "candy");
    for id in [1, 3] {
        h.call(id, "api/submit", Some(req.clone())).await;
        assert_eq!(h.result(id, "21", true, true).await.0, 200);
    }
    assert_eq!(h.executes, 0);
    h.maintenance(5, 1000).await;
    h.result(5, "21", true, true).await;
    assert_eq!(h.executes, 0);
    h.maintenance(7, 180000).await;
    h.result(7, "21", true, true).await;
    assert_eq!(h.executes, 1);
    let job = &h.jobs["tasks/job-candy"].0;
    assert_eq!(job["status"], "completed");
    assert_eq!(job["verdict"], "correct");
    h.call(9, "api/submit", Some(req)).await;
    h.result(9, "29", true, true).await;
    h.maintenance(11, 180000).await;
    h.result(11, "29", true, true).await;
    assert_eq!(h.executes, 1);
    h.shutdown().await;
}

#[tokio::test]
async fn background_invalid_sample_pauses_and_resume_reuses_plan() {
    let mut h = Host::start().await;
    h.call(1, "api/submit", Some(run("job-fp", "fingerprint")))
        .await;
    h.result(1, "", true, true).await;
    let plan = h.jobs["tasks/job-fp"].0["plan"].clone();
    h.maintenance(3, 180000).await;
    h.result(3, "21", true, true).await;
    assert_eq!(h.jobs["tasks/job-fp"].0["status"], "paused");
    assert_eq!(h.executes, 1);
    h.maintenance(5, 180000).await;
    h.result(5, "21", true, true).await;
    assert_eq!(h.executes, 1);
    h.call(7, "api/resume", Some(json!({"id":"job-fp"}))).await;
    assert_eq!(h.result(7, "", true, true).await.0, 200);
    h.maintenance(9, 180000).await;
    h.result(9, "21", true, true).await;
    assert_eq!(h.jobs["tasks/job-fp"].0["plan"], plan);
    assert_eq!(h.executes, 2);
    assert_eq!(
        h.jobs["tasks/job-fp"].0["attempts"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    h.shutdown().await;
}

#[tokio::test]
async fn background_identity_change_blocks_execution() {
    let mut h = Host::start().await;
    h.call(1, "api/submit", Some(run("identity", "candy")))
        .await;
    h.result(1, "", true, true).await;
    h.identity = "other-user".into();
    h.maintenance(3, 180000).await;
    h.result(3, "21", true, true).await;
    assert_eq!(h.executes, 0);
    assert_eq!(h.jobs["tasks/identity"].0["reason"], "identity_changed");
    h.call(5, "api/resume", Some(json!({"id":"identity"})))
        .await;
    assert_eq!(h.result(5, "", true, true).await.0, 409);
    h.shutdown().await;
}

#[tokio::test]
async fn background_recovers_durable_outcome_without_replaying() {
    let mut h = Host::start().await;
    h.call(1, "api/submit", Some(run("recover", "candy"))).await;
    h.result(1, "", true, true).await;
    h.fail_task_save = true;
    h.maintenance(3, 180000).await;
    assert_eq!(h.result(3, "21", true, true).await.0, 500);
    assert_eq!(h.jobs["tasks/recover"].0["status"], "running");
    assert!(h.jobs.contains_key("samples/recover-0"));
    h.maintenance(5, 180000).await;
    h.result(5, "29", true, true).await;
    assert_eq!(h.executes, 1);
    assert_eq!(h.jobs["tasks/recover"].0["verdict"], "correct");
    h.shutdown().await;
}

#[tokio::test]
async fn background_unknown_intent_requires_explicit_resume() {
    let mut h = Host::start().await;
    h.call(1, "api/submit", Some(run("unknown", "candy"))).await;
    h.result(1, "", true, true).await;
    let (job, _) = h.jobs.get_mut("tasks/unknown").unwrap();
    job["status"] = json!("running");
    job["pending"] = json!({"key":"unknown-0","step":0});
    h.maintenance(3, 180000).await;
    h.result(3, "21", true, true).await;
    assert_eq!(h.executes, 0);
    assert_eq!(h.jobs["tasks/unknown"].0["reason"], "uncertain");
    h.call(5, "api/task", Some(json!({"id":"unknown"}))).await;
    assert_eq!(
        h.result(5, "", true, true).await.1["record"]["canResume"],
        true
    );
    h.call(7, "api/resume", Some(json!({"id":"unknown"}))).await;
    h.result(7, "", true, true).await;
    h.maintenance(9, 180000).await;
    h.result(9, "21", true, true).await;
    assert_eq!(h.executes, 1);
    h.shutdown().await;
}

#[tokio::test]
async fn background_keeps_valid_samples_when_later_request_fails() {
    let mut h = Host::start().await;
    h.call(1, "api/submit", Some(run("retained", "fingerprint")))
        .await;
    h.result(1, "", true, true).await;
    let fixtures: Value =
        serde_json::from_slice(include_bytes!("fixtures/fingerprint.json")).unwrap();
    let text = format!(
        "{},{}",
        fixtures[0]["text"].as_str().unwrap(),
        fixtures[0]["text"].as_str().unwrap()
    );
    h.failure_after = Some(2);
    h.maintenance(3, 180000).await;
    h.result(3, &text, true, true).await;
    let saved = &h.jobs["tasks/retained"].0;
    assert_eq!(saved["status"], "paused");
    assert!(saved["accepted"][0].is_string());
    assert!(saved["accepted"][1].is_null());
    let first = saved["accepted"][0].clone();
    h.failure_after = None;
    h.call(5, "api/resume", Some(json!({"id":"retained"})))
        .await;
    h.result(5, "", true, true).await;
    h.maintenance(7, 180000).await;
    h.result(7, &text, true, true).await;
    assert_eq!(h.executes, 4);
    assert_eq!(h.jobs["tasks/retained"].0["accepted"][0], first);
    assert_eq!(h.jobs["tasks/retained"].0["status"], "completed");
    h.shutdown().await;
}

#[tokio::test]
async fn stopping_after_outcome_commit_preserves_answer() {
    let mut h = Host::start().await;
    h.call(1, "api/submit", Some(run("stop-recovery", "candy")))
        .await;
    h.result(1, "", true, true).await;
    h.fail_task_save = true;
    h.maintenance(3, 180000).await;
    assert_eq!(h.result(3, "21", true, true).await.0, 500);
    h.call(5, "api/stop", Some(json!({"id":"stop-recovery"})))
        .await;
    assert_eq!(h.result(5, "", true, true).await.0, 200);
    assert_eq!(h.jobs["tasks/stop-recovery"].0["status"], "stopped");
    assert_eq!(
        h.jobs["tasks/stop-recovery"].0["attempts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    h.call(
        7,
        "api/sample",
        Some(json!({"id":"stop-recovery","key":"stop-recovery-0"})),
    )
    .await;
    assert_eq!(
        h.result(7, "", true, true).await.1["sample"]["answer"]["text"],
        "21"
    );
    h.call(9, "api/delete", Some(json!({"id":"stop-recovery"})))
        .await;
    h.result(9, "", true, true).await;
    assert!(!h.jobs.contains_key("samples/stop-recovery-0"));
    assert!(!h.jobs.contains_key("tasks/stop-recovery"));
    h.shutdown().await;
}

#[tokio::test]
async fn stable_upstream_identity_allows_credential_refresh() {
    let mut h = Host::start().await;
    h.call(1, "api/submit", Some(run("refresh", "candy"))).await;
    h.result(1, "", true, true).await;
    h.credential_revision = 2;
    h.maintenance(3, 180000).await;
    h.result(3, "21", true, true).await;
    assert_eq!(h.executes, 1);
    assert_eq!(h.jobs["tasks/refresh"].0["verdict"], "correct");
    h.shutdown().await;
}

fn batch(id: &str, kind: &str, repeats: usize) -> Value {
    json!({"id":id,"accountIds":["account-test"],"clientKeyId":"key-test","model":"gpt-test","effort":"","kind":kind,"profile":"simple-v1","repeats":repeats,"concurrency":2,"outputVersion":"svg-v1"})
}
#[tokio::test]
async fn batch_repeats_are_idempotent_and_freeze_conditions() {
    let mut h = Host::start().await;
    let req = batch("repeat-batch", "candy", 3);
    for id in [1, 3] {
        h.call(id, "api/batch-submit", Some(req.clone())).await;
        let (status, result) = h.result(id, "21", true, true).await;
        assert_eq!(status, 200);
        assert_eq!(result["batch"]["taskIds"].as_array().unwrap().len(), 3);
        assert!(result["batch"].get("prepared").is_none());
    }
    assert_eq!(h.executes, 0);
    let frozen = h.jobs["tasks/repeat-batch-0-0"].0.clone();
    let mut changed = req;
    changed["profile"] = json!("codex-context-v1");
    h.call(5, "api/batch-submit", Some(changed)).await;
    assert_eq!(h.result(5, "", false, true).await.0, 409);
    assert_eq!(h.jobs["tasks/repeat-batch-0-0"].0, frozen);
    h.maintenance(7, 180000).await;
    h.result(7, "21", true, true).await;
    assert_eq!(h.executes, 3);
    for n in 0..3 {
        assert_eq!(
            h.jobs[&format!("tasks/repeat-batch-0-{n}")].0["verdict"],
            "correct"
        );
    }
    h.shutdown().await;
}
#[tokio::test]
async fn batch_stop_is_durable_and_does_not_consume_or_resume() {
    let mut h = Host::start().await;
    h.call(1, "api/batch-submit", Some(batch("stop-batch", "candy", 3)))
        .await;
    assert_eq!(h.result(1, "", false, true).await.0, 200);
    h.call(3, "api/batch-stop", Some(json!({"id":"stop-batch"})))
        .await;
    assert_eq!(h.result(3, "", false, true).await.0, 200);
    h.maintenance(5, 180000).await;
    h.result(5, "21", true, true).await;
    assert_eq!(h.executes, 0);
    for n in 0..3 {
        assert_eq!(
            h.jobs[&format!("tasks/stop-batch-0-{n}")].0["status"],
            "stopped"
        );
    }
    h.call(7, "api/resume", Some(json!({"id":"stop-batch-0-0"})))
        .await;
    assert_eq!(h.result(7, "", false, true).await.0, 409);
    h.shutdown().await;
}
#[tokio::test]
async fn batch_validation_rejects_reserved_ids_and_duplicate_accounts() {
    let mut h = Host::start().await;
    for (n, id) in ["index", "settings", "workspace"].iter().enumerate() {
        h.call(
            1 + n as u64 * 2,
            "api/batch-submit",
            Some(batch(id, "candy", 1)),
        )
        .await;
        assert_eq!(h.result(1 + n as u64 * 2, "", false, true).await.0, 400);
    }
    let mut req = batch("bad", "candy", 1);
    req["accountIds"] = json!(["account-test", "account-test"]);
    h.call(9, "api/batch-submit", Some(req)).await;
    assert_eq!(h.result(9, "", false, true).await.0, 400);
    assert_eq!(h.executes, 0);
    assert!(h.jobs.is_empty());
    h.shutdown().await;
}

#[tokio::test]
async fn stopping_a_batch_account_covers_repeats_and_blocks_future_resume() {
    let mut h = Host::start().await;
    h.call(
        1,
        "api/batch-submit",
        Some(batch("account-stop", "candy", 3)),
    )
    .await;
    assert_eq!(h.result(1, "", false, true).await.0, 200);
    h.call(
        3,
        "api/account-stop",
        Some(json!({"id":"account-stop","account_id":"account-test"})),
    )
    .await;
    assert_eq!(h.result(3, "", false, true).await.0, 200);
    assert_eq!(
        h.jobs["batches/account-stop"].0["stoppedAccounts"],
        json!(["account-test"])
    );
    h.maintenance(5, 180000).await;
    h.result(5, "21", true, true).await;
    for n in 0..3 {
        assert_eq!(
            h.jobs[&format!("tasks/account-stop-0-{n}")].0["status"],
            "stopped"
        );
    }
    assert_eq!(h.executes, 0);
    h.call(7, "api/resume", Some(json!({"id":"account-stop-0-0"})))
        .await;
    assert_eq!(h.result(7, "", false, true).await.0, 409);
    h.shutdown().await;
}

#[tokio::test]
async fn interrupted_batch_creation_recovers_frozen_plan_without_early_execution() {
    let mut h = Host::start().await;
    h.fail_create_task = true;
    let req = batch("creation-recovery", "fingerprint", 1);
    h.call(1, "api/batch-submit", Some(req.clone())).await;
    assert_eq!(h.result(1, "", false, true).await.0, 409);
    let frozen = h.jobs["batches/creation-recovery"].0["prepared"][0]["plan"].clone();
    assert!(frozen.is_array());
    h.maintenance(3, 180000).await;
    h.result(3, "", false, true).await;
    assert_eq!(h.executes, 0);
    h.call(5, "api/batch-submit", Some(req)).await;
    assert_eq!(h.result(5, "", false, true).await.0, 200);
    assert_eq!(h.jobs["tasks/creation-recovery-0-0"].0["plan"], frozen);
    assert_eq!(h.jobs["batches/creation-recovery"].0["ready"], true);
    h.shutdown().await;
}

#[tokio::test]
async fn failed_initial_batch_commit_does_not_duplicate_the_reserved_index() {
    let mut h = Host::start().await;
    h.fail_create_batch = true;
    let req = batch("reserved-index", "candy", 1);
    h.call(1, "api/batch-submit", Some(req.clone())).await;
    assert_eq!(h.result(1, "", false, true).await.0, 409);
    assert_eq!(h.jobs["batches/index"].0["ids"], json!(["reserved-index"]));
    assert!(!h.jobs.contains_key("batches/reserved-index"));
    h.call(3, "api/batch-submit", Some(req)).await;
    assert_eq!(h.result(3, "", false, true).await.0, 200);
    assert_eq!(h.jobs["batches/index"].0["ids"], json!(["reserved-index"]));
    assert_eq!(h.executes, 0);
    h.shutdown().await;
}

#[tokio::test]
async fn host_private_workspace_survives_reload_and_rejects_stale_writes() {
    let mut h = Host::start().await;
    h.call(1, "api/workspace", None).await;
    let (status, body) = h.result(1, "", false, true).await;
    assert_eq!(status, 200);
    assert_eq!(body["draft"], Value::Null);
    let draft = json!({"kind":"candy","model":"model-test","keyId":"key-test",
        "selected":["account-test"],"focus":"account-test","batchId":"",
        "drafts":{},"pending":batch("recover-id","candy",1),"effort":"",
        "profile":"simple-v1","repeats":1,"outputVersion":"svg-v1"});
    let save = json!({"draft":draft,"expectedVersion":null});
    h.call(3, "api/workspace", Some(save.clone())).await;
    let (status, saved) = h.result(3, "", false, true).await;
    assert_eq!(status, 200);
    assert!(saved["version"].is_number());
    h.call(5, "api/workspace", None).await;
    let (status, restored) = h.result(5, "", false, true).await;
    assert_eq!(status, 200);
    assert_eq!(restored["draft"], draft);
    h.call(7, "api/workspace", Some(save)).await;
    assert_eq!(h.result(7, "", false, true).await.0, 409);
    assert_eq!(h.executes, 0);
    assert_eq!(h.jobs["batches/workspace"].0, draft);
    h.shutdown().await;
}
