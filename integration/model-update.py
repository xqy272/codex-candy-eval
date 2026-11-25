"""Verify the 1.4.6 upgrade and request paths on the disposable CPR host."""

import argparse
from datetime import datetime, timezone
import json
import time
import uuid

from native_client import Client, ROOT, WORK


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("stage", choices=["seed", "upgrade", "business"])
args = parser.parse_args()
client = Client()
state_path = WORK / "state.json"
state = json.loads(state_path.read_text())
report_path = WORK / "model-update-native.json"
report = {"checks": []} if args.stage == "seed" else json.loads(report_path.read_text())
ids = [next(a["account_id"] for a in state["accounts"] if a["name"] == f"Eval account {letter}") for letter in "AB"]


def route(path, data=None):
    status, value = client.route(path, data)
    assert status == 200, (path, status, value)
    return value


def wait_until(callback, seconds=150):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if value := callback():
            return value
        time.sleep(.3)
    raise TimeoutError(callback.__name__)


def task(task_id):
    return route("api/task", {"id": task_id})["record"]


def finished(task_id):
    def read_terminal_task():
        record = task(task_id)
        return record if record["status"] in {"completed", "paused", "stopped"} else None
    return wait_until(read_terminal_task)


def request(kind, model, *, effort="", version="svg-v1", account_ids=None):
    return {
        "id": uuid.uuid4().hex, "accountIds": account_ids or ids[:1], "clientKeyId": state["clientKeyId"],
        "model": model, "effort": effort, "kind": kind, "profile": "simple-v1",
        "repeats": 1, "concurrency": 2, "outputVersion": version,
    }


def submit(req, status="completed"):
    batch = route("api/batch-submit", req)["batch"]
    records = [finished(task_id) for task_id in batch["taskIds"]]
    assert all(record["status"] == status for record in records), [(r["status"], r["reason"]) for r in records]
    return batch, records


def sample(record):
    return route("api/sample", {"id": record["id"], "key": record["attempts"][0]["key"]})


def snapshot():
    return {path: route(path) for path in ["api/workspace", "api/tasks", "api/history", "api/batches"]}


def observations(model, field="timeline"):
    values = json.loads((WORK / "upstream-observations.json").read_text())[field]
    return [item for item in values if item["model"] == model]


def wait_for_calls(model, count, field="timeline"):
    def read_calls():
        calls = observations(model, field)
        return calls if len(calls) >= count else None
    calls = wait_until(read_calls, seconds=10)
    assert len(calls) == count
    return calls


def checkpoint(message):
    report["checks"].append(message)
    report["observedAtUtc"] = datetime.now(timezone.utc).isoformat()
    report_path.write_text(json.dumps(report, indent=2))
    state_path.write_text(json.dumps(state))
    print("PASS: " + message, flush=True)


if args.stage == "seed":
    wait_until(lambda: "eval-pelican" in route("api/models", {"clientKeyId": state["clientKeyId"]})["models"])
    _, [paused_fp] = submit(request("fingerprint", "eval-incomplete"), "paused")
    _, [paused_ciallo] = submit(request("ciallo", "eval-ciallo-incomplete", account_ids=ids[1:]), "paused")
    _, [old_drawing] = submit(request("pelican", "eval-pelican"))
    state["modelUpdateRecords"] = [r["id"] for r in [paused_fp, paused_ciallo, old_drawing]]
    drafts = {"effort": "", "profile": "simple-v1", "repeats": 1, "outputVersion": "svg-v1",
              "batchId": old_drawing["batchId"], "focus": ids[0]}
    route("api/workspace", {"expectedVersion": route("api/workspace")["version"], "draft": {
        **drafts, "kind": "pelican", "model": "eval-pelican", "keyId": state["clientKeyId"],
        "selected": ids, "drafts": {}, "pending": None,
    }})
    before = {"snapshot": snapshot(), "records": [task(i) for i in state["modelUpdateRecords"]],
              "samples": [sample(r) for r in [paused_fp, paused_ciallo, old_drawing]]}
    (WORK / "model-update-before.json").write_text(json.dumps(before))
    checkpoint("1.4.5 on CPR 3.53.1 seeded a v1 drawing and saved incomplete fingerprint and Ciallo samples")
elif args.stage == "upgrade":
    archive = ROOT / "dist/cloudops.codex-candy-eval-1.4.6-x86_64-unknown-linux-gnu.tar.gz"
    _, digest = client.install(archive)
    instance = next(i for i in client.api("/api/admin/plugins/instances") if i["id"] == state["instanceId"])
    client.api("/api/admin/plugins/instances/switch-version", {
        "id": instance["id"], "target": {"artifactSha256": digest, "expectedRevision": instance["revision"]},
    })
    state["artifactSha256"] = digest
    report["archiveSha256"] = digest
    before = json.loads((WORK / "model-update-before.json").read_text())
    assert snapshot() == before["snapshot"]
    records = [task(i) for i in state["modelUpdateRecords"]]
    assert records == before["records"] and [sample(r) for r in records] == before["samples"]
    paused_fp, paused_ciallo, _ = records
    assert client.route("api/resume", {"id": paused_fp["id"]})[0] == 409
    assert task(paused_fp["id"]) == paused_fp
    wait_for_calls("eval-incomplete", 1)
    route("api/resume", {"id": paused_ciallo["id"]})
    resumed = finished(paused_ciallo["id"])
    assert resumed["status"] == "paused" and len(resumed["attempts"]) == 2
    assert resumed["frozenPlan"] == paused_ciallo["frozenPlan"]
    assert sample(resumed) == before["samples"][1]
    _, [smoke] = submit(request("candy", "eval-candy"))
    assert smoke["pluginVersion"] == "1.4.6" and smoke["verdict"] == "correct"
    checkpoint("Same-instance upgrade on CPR 3.53.1 preserves old state, blocks cross-detector retries without replay and permits explicit Ciallo retry")
else:
    (WORK / "switch-complete").unlink(missing_ok=True)
    (WORK / "switch-host").write_text("0")
    wait_until((WORK / "switch-complete").exists)
    client = Client()
    wait_until(lambda: {"gpt-6.2-sol", "gpt-6.2-astra"} <= set(route("api/models", {"clientKeyId": state["clientKeyId"]})["models"]))
    for model, effort in [("gpt-6.2-sol", ""), ("gpt-6.2-astra", "xhigh")]:
        bad = request("candy", model, effort="none")
        assert client.route("api/batch-submit", bad)[0] == 400
        _, [record] = submit(request("candy", model, effort=effort))
        assert record["verdict"] == "correct" and record["model"] == model
        [recorded] = wait_for_calls(model, 1)
        assert recorded["effort"] == (effort or None)
    checkpoint("CPR 3.54.5 accepts both GPT-6.2 IDs from a loopback upstream; default omits effort while explicit xhigh reaches the fixture")
    _, fingerprints = submit(request("fingerprint", "eval-fp", account_ids=ids))
    for record in fingerprints:
        assert record["validSamples"] == 3
        attribution = record["attribution"]
        assert attribution["decision"] == "scored"
        assert {r["model"] for r in attribution["results"]} >= {"gpt-6.2-sol", "gpt-6.2-astra"}
    checkpoint("New fingerprint tasks in the upgraded instance retain strict-three ranking with both GPT-6.2 candidates")
    drawing, drawings = submit(request("pelican", "eval-pelican-wrapped", version="svg-v2", account_ids=ids))
    for record in drawings:
        saved = sample(record)["sample"]
        assert record["outputVersion"] == "svg-v2"
        assert saved["prompt"] == "Generate an SVG of a pelican riding a bicycle" and not saved["instructions"]
        assert saved["answer"]["text"].count('<use href="#wheel"') == 2
    drawing_calls = wait_for_calls("eval-pelican-wrapped", 2, "request_facts")
    assert all(item["input_items"] == 1 and item["instructions_chars"] == item["tools"] == 0 for item in drawing_calls)
    state["modelUpdateDrawingBatch"] = drawing["request"]["id"]
    _, ciallos = submit(request("ciallo", "eval-ciallo", account_ids=ids))
    assert all(record["verdict"] == "responded" for record in ciallos)
    assert all(r["plainCiallo"] for r in wait_for_calls("eval-ciallo", 2))
    wait_for_calls("eval-incomplete", 1)
    checkpoint("Pelican v2 sends the revised prompt, saves both-wheel SVG fixtures, and the existing Ciallo flow still completes")
