//! 通过宿主迁移事务保留历史，schema 扩容不改写原记录
use gateway_plugin_sdk::{
    ErrorCode, PluginFault,
    call::host::{StateMigrationChange, StateMigrationRequest, StateMigrationResult},
};

pub fn migrate(request: StateMigrationRequest) -> Result<StateMigrationResult, PluginFault> {
    if request.namespace != "history"
        || request.from_schema_version != 1
        || request.to_schema_version != 2
    {
        return Err(PluginFault::new(
            ErrorCode::InvalidInput,
            "不支持该历史状态迁移",
        ));
    }
    // 旧平面记录和 1.1.0 摘要都满足扩大后的 schema，保持内容和执行意图
    Ok(StateMigrationResult {
        changes: request
            .records
            .into_iter()
            .map(|r| StateMigrationChange::Keep { key: r.key })
            .collect(),
    })
}
