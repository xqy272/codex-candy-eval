//! 组装管理能力，模型执行与账号状态继续由 CPR 持有
mod evaluation;
mod history;
pub mod jobs;
mod management;
pub mod migration;
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
    let maintenance_state = Arc::clone(&state);
    Ok(
        PluginBuilder::from_json(include_bytes!("../../plugin.json"))?
            .management(management::registration(), move |call| {
                let state = Arc::clone(&state);
                async move { management::handle(state, call).await }
            })?
            .on(
                gateway_plugin_sdk::client::methods::RECONCILE,
                move |call| {
                    let state = Arc::clone(&maintenance_state);
                    async move {
                        jobs::tick(state, &call).await?;
                        Ok(gateway_plugin_sdk::client::TypedReply::new(
                            gateway_plugin_sdk::client::Empty {},
                        ))
                    }
                },
            )?
            .on(
                gateway_plugin_sdk::client::methods::STATE_MIGRATE,
                |call| async move {
                    migration::migrate(call.request)
                        .map(gateway_plugin_sdk::client::TypedReply::new)
                },
            )?
            .build()?,
    )
}
