//! 从 SDK 事件提取文本与完整终态，握手和流结束不算完成
use gateway_plugin_sdk::call::{
    host::ModelEventBatch,
    model::{CanonicalEvent, FinishReason, Usage, WirePayload},
};
use serde::{Deserialize, Serialize};

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub text: String,
    pub completed: bool,
    pub usage: Usage,
}

pub fn decode(bytes: &[u8]) -> Result<Answer, &'static str> {
    let batch = ModelEventBatch::decode(bytes).map_err(|_| "invalid_events")?;
    let mut result = Answer::default();
    let mut terminals = 0;
    let mut failed = false;
    for event in batch.events {
        if let Some(wire) = event.wire {
            match wire.payload {
                WirePayload::Json { event, data, .. }
                | WirePayload::WebSocket {
                    event,
                    data: Some(data),
                    ..
                } if event
                    .as_deref()
                    .or_else(|| data.get("type").and_then(|v| v.as_str()))
                    .is_some_and(|kind| {
                        matches!(kind, "error" | "response.failed" | "response.incomplete")
                    }) =>
                {
                    failed = true;
                }
                _ => {}
            }
        }
        for fact in event.facts {
            match fact {
                CanonicalEvent::TextDelta { text, .. } => {
                    if result.text.len() + text.len() > 48 * 1024 {
                        return Err("answer_too_large");
                    }
                    result.text.push_str(&text);
                }
                CanonicalEvent::Usage { usage } => result.usage = usage,
                CanonicalEvent::Completed { reason, .. } => {
                    terminals += 1;
                    result.completed = reason == FinishReason::Stop;
                }
                _ => {}
            }
        }
    }
    if failed || terminals != 1 || !result.completed {
        return Err("incomplete");
    }
    if result.text.trim().is_empty() {
        return Err("empty_answer");
    }
    Ok(result)
}
