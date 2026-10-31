//! 验证迁移只保留宿主给定记录，拒绝未声明的迁移方向
use gateway_plugin_sdk::call::host::{
    StateMigrationChange, StateMigrationRecord, StateMigrationRequest,
};
use serde_json::json;
#[test]
fn keeps_legacy_and_summary_records_without_rewriting_intents() {
    for value in [
        json!({"records":[{"id":"legacy","status":"correct","samples":[{"answer":{"text":"21"}}]}]}),
        json!({"records":[{"id":"pending","summaryOnly":true,"status":"running","pendingStep":1}]}),
    ] {
        let result = cpr_candy_eval::migration::migrate(StateMigrationRequest {
            namespace: "history".into(),
            from_schema_version: 1,
            to_schema_version: 2,
            records: vec![StateMigrationRecord {
                key: "records".into(),
                value,
                version: 7,
            }],
        })
        .unwrap();
        assert!(matches!(&result.changes[..],[StateMigrationChange::Keep{key}] if key=="records"));
    }
}
#[test]
fn rejects_undeclared_migration() {
    assert!(
        cpr_candy_eval::migration::migrate(StateMigrationRequest {
            namespace: "details".into(),
            from_schema_version: 1,
            to_schema_version: 2,
            records: vec![]
        })
        .is_err()
    );
}
