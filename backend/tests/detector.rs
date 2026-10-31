//! 使用上游公开的一致性样本验证固定数据可完成离线排名
use std::path::Path;

#[test]
fn frozen_detector_scores_upstream_sample_without_network() {
    let detector = lmfpd::Detector::load(&lmfpd::LoadOptions {
        sources: vec![
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../data")
                .to_string_lossy()
                .into_owned(),
        ],
        ..Default::default()
    })
    .unwrap();
    let outputs: Vec<lmfpd::Output> =
        serde_json::from_slice(include_bytes!("fixtures/fingerprint.json")).unwrap();
    let result = detector.analyze(&outputs, true).unwrap();
    assert_eq!(result.decision, lmfpd::Decision::Scored);
    assert_eq!(result.prediction, "claude-haiku-4.5");
    assert!(result.results.iter().all(|r| r.score.is_finite()));
    assert!(result.results.windows(2).all(|v| v[0].score >= v[1].score));
    assert_eq!(detector.built_at(), "2026-10-27T05:02:50.758637+00:00");
}
