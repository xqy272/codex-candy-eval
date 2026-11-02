//! 校验宿主握手并启动账号测试插件，不向协议输出诊断文本
use gateway_plugin_sdk::{
    CallBudgets, Manifest, Stage,
    client::{PluginSession, SessionConfig},
};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut session = PluginSession::accept(
        tokio::io::stdin(),
        tokio::io::stdout(),
        SessionConfig::default(),
    )
    .await?;
    let manifest = Manifest::from_author_slice(include_bytes!("../../plugin.json"))?;
    if session.handshake().plugin_id != manifest.plugin_id()?
        || session.handshake().contributes != manifest.contributes
        || session.handshake().configuration != serde_json::json!({})
    {
        return Err("插件握手与清单不一致".into());
    }
    session.set_call_budgets(CallBudgets::from([
        (Stage::Management, 170_000),
        (Stage::Maintenance, 180_000),
    ]))?;
    let data = std::env::current_exe()?
        .parent()
        .and_then(|p| p.parent())
        .ok_or("插件资源目录无效")?
        .join("data");
    session.run(cpr_candy_eval::plugin(&data)?).await?;
    Ok(())
}
