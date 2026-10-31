//! 验证糖果评测沿用约定的独立数字 21 判分
#[test]
fn candy_uses_standalone_twenty_one() {
    for text in ["21", "最少 21 颗", "答案：\\boxed{21}", "21颗"] {
        assert!(cpr_candy_eval::prompts::has_answer(text));
    }
    for text in ["29", "121", "210", "没有答案", ""] {
        assert!(!cpr_candy_eval::prompts::has_answer(text));
    }
}
