//! 组装管理能力，模型执行与账号状态继续由 CPR 持有
mod evaluation;
mod history;
mod management;
pub mod model;
pub mod prompts;

use gateway_plugin_sdk::client::{ComposedPlugin, PluginBuilder};
use std::{path::Path, sync::Arc};

pub fn plugin(data: &Path) -> Result<ComposedPlugin, Box<dyn std::error::Error>> {
    let detector = lmfpd::Detector::load(&lmfpd::LoadOptions {
        sources: vec![data.to_string_lossy().into_owned()],
        ..Default::default()
    })?;
    let state = Arc::new(management::AppState::new(detector));
    Ok(
        PluginBuilder::from_json(include_bytes!("../../plugin.json"))?
            .management(management::registration(), move |call| {
                let state = Arc::clone(&state);
                async move { management::handle(state, call).await }
            })?
            .build()?,
    )
}
