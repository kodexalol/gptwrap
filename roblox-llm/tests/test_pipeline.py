from rbxcrawl import filters, pipeline
from rbxcrawl.records import iter_records, make_record, write_records

GOOD = '--!strict\nlocal Players = game:GetService("Players")\nPlayers.PlayerAdded:Connect(function(p: Player)\n\ttask.wait(1)\n\tprint(p.Name)\nend)\n'


def test_filter_then_dedup_end_to_end(tmp_path):
    raw = tmp_path / "raw"
    recs = [
        make_record("github", "code", "a", GOOD, stars=10),
        make_record("hf:x", "code", "b", GOOD.replace("print", "print ") + "-- copy\n"),          # exact dup (comments/ws)
        make_record("github", "code", "c", "local g = getgenv()\nhookfunction(print, print)\n" * 3),  # exploit
        make_record("github", "code", "d", "x"),                                                     # too short
        make_record("devforum", "qa", "e", "# Q\n\n## Question\n" + "How do I loop? " * 20, solved=True),
    ]
    write_records(raw, "mix", recs)
    rep = pipeline.run_filter([raw], tmp_path / "filtered", workers=1)
    assert rep["seen"] == 5 and rep["kept"] == 3
    assert rep["reasons"] == {"exploit": 1, "too_short": 1}
    ded = pipeline.run_dedup([tmp_path / "filtered"], tmp_path / "clean")
    assert ded["kept"] == 2 and ded["reasons"] == {"exact_dup": 1}
    out = list(iter_records(tmp_path / "clean"))
    assert {r["key"] for r in out} == {"a", "e"}  # first-seen wins
    assert all("flags" in r for r in out) and out[0]["flags"]["quality"] > 0
    s = pipeline.summarize(tmp_path / "clean")
    assert s["records"] == 2 and s["by_source"] == {"github": 1, "devforum": 1}


def test_parallel_filter_matches_serial(tmp_path):
    raw = tmp_path / "raw"
    for i in range(3):
        write_records(raw, f"s{i}", [make_record("github", "code", f"{i}-{j}", GOOD + f"-- {i}{j}\n") for j in range(5)])
    a = pipeline.run_filter([raw], tmp_path / "a", workers=1)
    b = pipeline.run_filter([raw], tmp_path / "b", workers=3)
    assert a == b and a["kept"] == 15
