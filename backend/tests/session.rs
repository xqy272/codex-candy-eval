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
    version: u64,
    executes: usize,
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
                .set_call_budgets(gateway_plugin_sdk::CallBudgets::from([(
                    Stage::Management,
                    600_000,
                )]))
                .unwrap();
            session.run(handler).await.unwrap();
        });
        let (reader, writer) = tokio::io::split(host);
        let mut this = Self {
            reader,
            writer,
            task,
            saved: None,
            version: 0,
            executes: 0,
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
                        result["status"].as_u64().unwrap(),
                        serde_json::from_slice(&frame.payload).unwrap(),
                    );
                }
                Message::Callback {
                    id, method, params, ..
                } => match method.as_str() {
                    "host.model.execute" => {
                        self.executes += 1;
                        assert_eq!(params["account_id"], "account-test");
                        assert_eq!(params["client_key_id"], "key-test");
                        assert_eq!(params["provider"], "openai");
                        let body: Value = serde_json::from_slice(&frame.payload).unwrap();
                        assert_eq!(body["store"], false);
                        assert_eq!(body["tools"], json!([]));
                        assert!(body["instructions"].is_string());
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
                            json!({"request_id":"request-test","events":count}),
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
                        if save || params["value"]["records"][0]["pendingStep"].is_number() {
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
                    "host.model.execute" => return id,
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
    assert!(host.consumed.contains(&callback_id));
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
