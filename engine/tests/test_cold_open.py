"""Cold open: the planner's hook rules, the timeline helpers and the real join.

No network. The join test renders flash/beep fixtures with FFmpeg and checks
that picture and sound stay together across the cut.
"""

import asyncio
import os
import shutil

import pytest

from clip_engine.services.cold_open import merge_srt, shift_chapters
from clip_engine.services.intelligence_planner import CLIP_PLAN_SCHEMA, IntelligencePlannerService
from tests.test_planner import make_planner, make_transcript


# ── Planner rules ────────────────────────────────────────────────────────────

def hook(planner, raw, *, start_ms=60_000, end_ms=120_000, skips=(), longform=False, transcript=None):
    segments = make_transcript(300).segments if transcript is None else transcript
    return planner._clean_hook(raw, start_ms, end_ms, list(skips), segments, True, longform)


class TestPlannerHook:
    def test_schema_asks_for_a_plain_number_hook(self):
        item = CLIP_PLAN_SCHEMA["properties"]["clips"]["items"]
        assert {"hook_start", "hook_end"} <= set(item["required"])
        assert item["properties"]["hook_start"]["type"] == "number", "no nullable types: -1 means none"

    def test_a_good_hook_snaps_to_the_sentence_and_uses_transcript_words(self):
        result = hook(make_planner(), {"hook_start": 80.4, "hook_end": 84.0})
        assert result == (80_000, 84_500, "word80 end.")

    def test_the_hook_text_comes_from_the_transcript_not_the_model(self):
        result = hook(make_planner(), {"hook_start": 80, "hook_end": 84.5, "hook_text": "invented words"})
        assert "invented" not in result[2]

    @pytest.mark.parametrize("raw", [
        {"hook_start": None, "hook_end": None},
        {"hook_start": -1, "hook_end": -1},          # the model's "none"
        {"hook_start": 84.5, "hook_end": 80.0},      # backwards
        {},
        {"hook_start": 80},
        {"hook_start": True, "hook_end": 84.5},
        {"hook_start": "80", "hook_end": "84.5"},
        {"hook_start": float("nan"), "hook_end": 84.5},
        {"hook_start": 61.0, "hook_end": 64.5},      # the clip already opens with it
        {"hook_start": 130.0, "hook_end": 134.5},    # after the clip
        {"hook_start": 50.0, "hook_end": 54.5},      # before the clip
        {"hook_start": 80.0, "hook_end": 80.9},      # a fragment
        {"hook_start": 80.0, "hook_end": 99.0},      # a second clip
    ])
    def test_unusable_hooks_are_dropped_but_never_the_clip(self, raw):
        assert hook(make_planner(), raw) is None

    def test_a_hook_inside_a_cut_tangent_is_dropped(self):
        assert hook(make_planner(), {"hook_start": 80, "hook_end": 84.5}, skips=[(75_000, 90_000)]) is None
        assert hook(make_planner(), {"hook_start": 80, "hook_end": 84.5}, skips=[(90_000, 100_000)]) is not None

    def test_no_transcript_means_no_hook(self):
        assert hook(make_planner(), {"hook_start": 80, "hook_end": 84.5}, transcript=[]) is None

    def test_longform_allows_a_longer_hook(self):
        raw = {"hook_start": 80.0, "hook_end": 89.5}
        assert hook(make_planner(), raw, longform=False) is None
        assert hook(make_planner(), raw, longform=True) is not None

    def test_a_parsed_clip_carries_its_hook(self):
        planner = make_planner()
        planner._current_transcript = make_transcript(300).segments
        planner._current_duration_ranges = ["short"]
        clip = {
            "start_time": 60, "end_time": 100, "summary": "Never let it write", "pitch": "p",
            "scores": {"hook": 8, "standalone": 8, "arc": 8, "quotability": 8, "ending": 8},
            "tags": [], "emphasis": [], "hook_start": 80, "hook_end": 84.5,
        }
        response = {"choices": [{"message": {"content": '{"insights": "x", "clips": [%s]}' % __import__("json").dumps(clip)}}]}
        (segment,) = planner._parse_clip_plan_response(response).segments
        assert (segment.hook_start_ms, segment.hook_end_ms, segment.hook_text) == (80_000, 84_500, "word80 end.")

    def test_the_prompt_explains_the_cold_open(self):
        prompt = make_planner()._build_system_prompt(3, 30, 60)
        assert "COLD OPEN" in prompt and "hook_start" in prompt


# ── Timeline helpers ─────────────────────────────────────────────────────────

class TestTimelineHelpers:
    def test_chapters_keep_the_first_at_zero_and_move_the_rest(self):
        assert shift_chapters([(0, "Intro"), (30_000, "Setup"), (90_000, "Payoff")], 4_000) == [
            (0, "Intro"), (34_000, "Setup"), (94_000, "Payoff"),
        ]
        assert shift_chapters([], 4_000) == []

    def test_subtitles_get_the_hook_first_and_the_clip_moved_back(self):
        hook = "1\n00:00:00,000 --> 00:00:01,500\nNever let it\n\n2\n00:00:01,500 --> 00:00:03,000\nwrite for you\n\n"
        body = "1\n00:00:00,400 --> 00:00:02,000\nSo here is why\n\n2\n00:01:01,000 --> 00:01:03,250\nit goes wrong\n\n"
        merged = merge_srt(hook, body, 3_000)
        assert merged == (
            "1\n00:00:00,000 --> 00:00:01,500\nNever let it\n\n"
            "2\n00:00:01,500 --> 00:00:03,000\nwrite for you\n\n"
            "3\n00:00:03,400 --> 00:00:05,000\nSo here is why\n\n"
            "4\n00:01:04,000 --> 00:01:06,250\nit goes wrong\n\n"
        )

    def test_subtitles_survive_windows_line_endings_and_empty_input(self):
        assert merge_srt("", "1\r\n00:00:00,000 --> 00:00:01,000\r\nHi\r\n\r\n", 2_000) == "1\n00:00:02,000 --> 00:00:03,000\nHi\n\n"
        assert merge_srt("", "", 1_000) == ""


# ── The real join ────────────────────────────────────────────────────────────

FFMPEG = os.environ.get("TEST_FFMPEG") or shutil.which("ffmpeg")
FFPROBE = os.environ.get("TEST_FFPROBE") or shutil.which("ffprobe")
needs_ffmpeg = pytest.mark.skipif(not (FFMPEG and FFPROBE), reason="FFmpeg and FFprobe required")


@needs_ffmpeg
def test_the_joined_clip_keeps_picture_and_sound_together_across_the_cut(tmp_path, monkeypatch):
    """A flash and a beep every second at .5: any gap or overlap at the join breaks the rhythm."""
    import numpy as np
    from tests import test_av_sync as sync
    from clip_engine.services.rendering_service import RenderingService

    monkeypatch.setenv("PATH", os.path.dirname(FFMPEG) + os.pathsep + os.environ.get("PATH", ""))
    source = sync.source(tmp_path, duration=12)
    hook = shutil.copy(sync.render(source, tmp_path, duration=2, start=3), tmp_path / "hook.mp4")
    body = shutil.copy(sync.render(source, tmp_path, duration=6, start=0), tmp_path / "body.mp4")

    service = RenderingService.__new__(RenderingService)
    service._video_codec_args = lambda *args: ["-c:v", "mpeg4", "-q:v", "2", "-bf", "2"]
    joined = tmp_path / "joined.mp4"
    asyncio.run(service.join_cold_open(
        str(hook), str(body), str(joined), fps="30", size=(64, 64), hook_ms=2000, body_ms=6000,
    ))

    streams = {s["codec_type"]: s for s in sync.probe(joined)["streams"]}
    assert abs(float(streams["video"]["duration"]) - 8.0) < 0.05
    assert abs(float(streams["audio"]["duration"]) - 8.0) < 0.06
    flashes, beeps = sync.events(joined)
    expected = np.arange(8) + 0.5
    assert np.allclose(flashes, expected, atol=0.05), flashes
    assert np.allclose(beeps, expected, atol=0.05), beeps
    assert np.allclose(flashes, beeps, atol=0.04), "picture and sound stay together at the join"
