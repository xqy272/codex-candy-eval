# codex-candy-eval

- Read README.md, plugin.json and docs/verification.md before changing the plugin.
- This is a standalone CPR native plugin. Use public gateway-plugin-sdk APIs and the host management bridge; do not add an independent product HTTP service or read account secrets.
- Candy uses the original prompt and grades the standalone number 21. Fingerprint prompts and detector data are pinned in vendor/SOURCES.json; do not silently change them.
- Preserve plugin ID cloudops.codex-candy-eval and compatible private state for upgrades. Never automatically replay requests whose consumption is uncertain.
- Keep runtime credentials, build caches and generated archives out of Git. Publish tested archives and SHA-256 as release assets.
- Verify fixed sources, Rust fmt/clippy/tests, frontend build/UI tests for relevant code changes. Native host scripts in integration use controlled local fixtures; do not call production or real models by default.
- Record evidence honestly in docs/verification.md. Do not claim model identity accuracy from fixture tests. Do not widen CPR compatibility without verification.
- Version policy confirmed by the user on 2026-11-09: keep releases in 1.4.x by default, incrementing only the patch number. Do not advance to 1.5.x or a higher minor/major version unless the user explicitly requests it.
- After relevant verification passes, commit completed work, fast-forward push to origin/main, create the version tag, and publish the verified installation archive and SHA-256 as a GitHub Release by default. The user authorized this standing workflow for this repository on 2026-11-05; do not ask again for each push or release.
