//! 验证终态、失败帧和文本上限，避免把半截响应当作有效评测
use cpr_candy_eval::model::decode;
use gateway_plugin_sdk::call::{
    host::ModelEventBatch,
    model::{CanonicalEvent, ExecutionEvent, FinishReason, WireEvent, WirePayload},
};
use serde_json::json;

fn text(value: &str) -> ExecutionEvent {
    ExecutionEvent::canonical(CanonicalEvent::TextDelta {
        index: 0,
        text: value.into(),
    })
}
fn done(reason: FinishReason) -> ExecutionEvent {
    ExecutionEvent::canonical(CanonicalEvent::Completed {
        id: "response-test".into(),
        model: None,
        reason,
    })
}
fn parse(events: Vec<ExecutionEvent>) -> bool {
    decode(&ModelEventBatch { events }.encode().unwrap()).is_ok()
}
#[test]
fn accepts_only_complete_text_response() {
    assert!(parse(vec![text("21"), done(FinishReason::Stop)]));
    assert!(!parse(vec![text("21")]));
    assert!(!parse(vec![done(FinishReason::Stop)]));
    assert!(!parse(vec![text("21"), done(FinishReason::Length)]));
    assert!(!parse(vec![
        text("21"),
        done(FinishReason::Stop),
        done(FinishReason::Stop)
    ]));
}
#[test]
fn errors_override_a_completed_event() {
    for kind in ["error", "response.failed", "response.incomplete"] {
        let wire = ExecutionEvent::wire(WireEvent {
            protocol: "openai".into(),
            payload: WirePayload::Json {
                event: Some(kind.into()),
                data: json!({"type":kind}),
                id: None,
                retry: None,
                raw_sse: None,
            },
        });
        assert!(!parse(vec![text("21"), done(FinishReason::Stop), wire]));
    }
}
#[test]
fn rejects_oversized_and_malformed_output() {
    assert!(!parse(vec![
        text(&"x".repeat(128 * 1024 + 1)),
        done(FinishReason::Stop)
    ]));
    assert!(decode(b"HTTP 200").is_err());
}
