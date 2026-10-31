//! 通过宿主私有状态保存最近测试，不直接访问宿主数据库
use gateway_plugin_sdk::{
    ErrorCode, PluginFault,
    call::host::{StateGetRequest, StateGetResult, StatePutRequest, StatePutResult},
    client::{HostClient, SessionError},
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

pub async fn callback<I: Serialize, O: DeserializeOwned>(
    host: &HostClient,
    method: &str,
    input: I,
    payload: Vec<u8>,
) -> Result<(O, Vec<u8>), PluginFault> {
    let reply = host
        .call(
            method,
            serde_json::to_value(input).map_err(|_| invalid())?,
            payload,
        )
        .await
        .map_err(SessionError::into_plugin_fault)?;
    Ok((
        serde_json::from_value(reply.result).map_err(|_| invalid())?,
        reply.payload,
    ))
}
pub fn invalid() -> PluginFault {
    PluginFault::new(ErrorCode::Fault, "宿主返回了无效数据")
}

pub async fn load(host: &HostClient) -> Result<StateGetResult, PluginFault> {
    callback(
        host,
        "host.state.get",
        StateGetRequest {
            namespace: "history".into(),
            key: "records".into(),
        },
        vec![],
    )
    .await
    .map(|v| v.0)
}
pub async fn find(host: &HostClient, id: &str) -> Result<Option<Value>, PluginFault> {
    let saved = load(host).await?;
    match saved.record {
        Some(r) if r.schema_version == 1 => Ok(r
            .value
            .get("records")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?
            .iter()
            .find(|r| r["id"] == id)
            .cloned()),
        Some(_) => Err(invalid()),
        None => Ok(None),
    }
}

pub async fn append(host: &HostClient, record: Value) -> Result<(), PluginFault> {
    let previous = load(host).await?;
    let version = previous.record.as_ref().map(|r| r.version);
    let mut records = match previous.record {
        Some(r) if r.schema_version == 1 => r
            .value
            .get("records")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(invalid)?,
        Some(_) => return Err(invalid()),
        None => vec![],
    };
    records.retain(|r| r["id"] != record["id"]);
    records.insert(0, record);
    records.truncate(20);
    while serde_json::to_vec(&records).map_err(|_| invalid())?.len() > 240_000 && records.len() > 1
    {
        records.pop();
    }
    if serde_json::to_vec(&records).map_err(|_| invalid())?.len() > 240_000 {
        return Err(invalid());
    }
    let _: (StatePutResult, _) = callback(
        host,
        "host.state.put",
        StatePutRequest {
            namespace: "history".into(),
            key: "records".into(),
            expected_version: version,
            value: json!({"records":records}),
        },
        vec![],
    )
    .await?;
    Ok(())
}
