//! 使用上游公开的一致性样本验证固定数据可完成离线排名
use std::path::Path;

fn detector() -> lmfpd::Detector {
    lmfpd::Detector::load(&lmfpd::LoadOptions {
        sources: vec![
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../data")
                .to_string_lossy()
                .into_owned(),
        ],
        ..Default::default()
    })
    .unwrap()
}

#[test]
fn frozen_detector_scores_upstream_sample_without_network() {
    let detector = detector();
    let outputs: Vec<lmfpd::Output> =
        serde_json::from_slice(include_bytes!("fixtures/fingerprint.json")).unwrap();
    let result = detector.analyze(&outputs, true).unwrap();
    assert_eq!(result.decision, lmfpd::Decision::Scored);
    assert_eq!(result.prediction, "claude-haiku-4.5");
    assert!(result.results.iter().all(|r| r.score.is_finite()));
    assert!(result.results.windows(2).all(|v| v[0].score >= v[1].score));
    assert_eq!(detector.built_at(), "2026-11-23T06:25:02.164646+00:00");
    assert_eq!(result.results.len(), 76);
}

#[test]
fn gpt_62_reference_outputs_reach_calibrated_ranking() {
    let detector = detector();
    let fixtures: std::collections::BTreeMap<String, Vec<lmfpd::Output>> =
        serde_json::from_slice(include_bytes!("fixtures/fingerprint-gpt-6.2.json")).unwrap();
    assert_eq!(fixtures.len(), 2);
    for (model, outputs) in fixtures {
        let result = detector.analyze(&outputs, true).unwrap();
        assert_eq!(result.decision, lmfpd::Decision::Scored, "{model}");
        assert_eq!(result.used_outputs, 3);
        assert_eq!(result.prediction, model);
        assert!(result.probability.is_some());
    }
}
