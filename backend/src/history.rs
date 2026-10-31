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
    let indexed = saved
        .record
        .as_ref()
        .and_then(|r| r.value["records"].as_array())
        .and_then(|rows| rows.iter().find(|r| r["id"] == id));
    if let Some(record) = indexed
        && record["summaryOnly"] != true
    {
        return Ok(Some(record.clone()));
    }
    // 先查详情也覆盖详情已提交而索引尚未提交的中断窗口
    let detail: (StateGetResult, _) = callback(
        host,
        "host.state.get",
        StateGetRequest {
            namespace: "details".into(),
            key: id.into(),
        },
        vec![],
    )
    .await?;
    Ok(detail.0.record.map(|r| r.value["record"].clone()))
}

pub async fn remove_details(host: &HostClient, rows: &[Value]) -> Result<(), PluginFault> {
    for row in rows {
        if row["summaryOnly"] != true {
            continue;
        }
        let id = row["id"].as_str().ok_or_else(invalid)?;
        let (saved, _): (StateGetResult, _) = callback(
            host,
            "host.state.get",
            StateGetRequest {
                namespace: "details".into(),
                key: id.into(),
            },
            vec![],
        )
        .await?;
        if let Some(record) = saved.record {
            let _: (gateway_plugin_sdk::call::host::StateDeleteResult, _) = callback(
                host,
                "host.state.delete",
                gateway_plugin_sdk::call::host::StateDeleteRequest {
                    namespace: "details".into(),
                    key: id.into(),
                    expected_version: record.version,
                },
                vec![],
            )
            .await?;
        }
    }
    Ok(())
}

pub async fn append(host: &HostClient, record: Value) -> Result<(), PluginFault> {
    let previous = load(host).await?;
    let version = previous.record.as_ref().map(|r| r.version);
    let mut records = previous
        .record
        .map(|r| r.value["records"].as_array().cloned().ok_or_else(invalid))
        .transpose()?
        .unwrap_or_default();
    let old = records.clone();
    let id = record["id"].as_str().ok_or_else(invalid)?;
    let bytes = serde_json::to_vec(&record).map_err(|_| invalid())?.len();
    if bytes > 240_000 {
        return Err(invalid());
    }
    let mut summary = record.clone();
    summary["samples"] = json!([]);
    summary["remaining"] = json!([]);
    summary["summaryOnly"] = json!(true);
    summary["detailBytes"] = json!(bytes);
    if let Some(a) = summary["attribution"].as_object_mut() {
        a.retain(|k, _| {
            matches!(
                k.as_str(),
                "prediction"
                    | "prediction_name"
                    | "family_prediction_name"
                    | "probability"
                    | "decision"
                    | "used_outputs"
            )
        });
        a.insert("results".into(), json!([]));
    }
    records.retain(|r| r["id"] != id);
    records.insert(0, summary);
    let mut counts = std::collections::HashMap::new();
    records.retain(|r| {
        let key = (
            r["accountId"].as_str().unwrap_or_default().to_owned(),
            r["kind"].as_str().unwrap_or_default().to_owned(),
        );
        let count = counts.entry(key).or_insert(0);
        *count += 1;
        *count <= 20
    });
    records.truncate(200);
    while (serde_json::to_vec(&records).map_err(|_| invalid())?.len() > 220_000
        || records
            .iter()
            .map(|r| r["detailBytes"].as_u64().unwrap_or(0))
            .sum::<u64>()
            > 15_000_000)
        && records.len() > 1
    {
        records.pop();
    }
    let removed: Vec<Value> = old
        .into_iter()
        .filter(|r| !records.iter().any(|v| v["id"] == r["id"]))
        .collect();
    // 详情先提交，调用意图的索引提交成功后才允许执行模型
    let (detail, _): (StateGetResult, _) = callback(
        host,
        "host.state.get",
        StateGetRequest {
            namespace: "details".into(),
            key: id.into(),
        },
        vec![],
    )
    .await?;
    let _: (StatePutResult, _) = callback(
        host,
        "host.state.put",
        StatePutRequest {
            namespace: "details".into(),
            key: id.into(),
            expected_version: detail.record.map(|r| r.version),
            value: json!({"record":record}),
        },
        vec![],
    )
    .await?;
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
    remove_details(host, &removed).await?;
    Ok(())
}
