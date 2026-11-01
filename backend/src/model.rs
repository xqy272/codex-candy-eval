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

#[derive(Default)]
pub struct Decoder {
    answer: Answer,
    terminals: usize,
    failed: bool,
}
impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<(), &'static str> {
        let batch = ModelEventBatch::decode(bytes).map_err(|_| "invalid_events")?;
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
                        self.failed = true
                    }
                    _ => {}
                }
            }
            for fact in event.facts {
                match fact {
                    CanonicalEvent::TextDelta { text, .. } => {
                        if self.answer.text.len() + text.len() > 48 * 1024 {
                            return Err("answer_too_large");
                        }
                        self.answer.text.push_str(&text);
                    }
                    CanonicalEvent::Usage { usage } => self.answer.usage = usage,
                    CanonicalEvent::Completed { reason, .. } => {
                        self.terminals += 1;
                        self.answer.completed = reason == FinishReason::Stop;
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }
    pub fn diagnostic(&self) -> serde_json::Value {
        serde_json::json!({"code":"decoder","kind":"terminal_validation","terminalCount":self.terminals,"stop":self.answer.completed,"failedWire":self.failed,"textBytes":self.answer.text.len()})
    }
    pub fn finish(self) -> Result<Answer, &'static str> {
        if self.failed || self.terminals != 1 || !self.answer.completed {
            return Err("incomplete");
        }
        if self.answer.text.trim().is_empty() {
            return Err("empty_answer");
        }
        Ok(self.answer)
    }
}
pub fn decode(bytes: &[u8]) -> Result<Answer, &'static str> {
    let mut decoder = Decoder::default();
    decoder.push(bytes)?;
    decoder.finish()
}
