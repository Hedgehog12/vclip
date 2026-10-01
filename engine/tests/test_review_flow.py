"""
Idea review: an analyze run stops after planning and keeps its source; render
rounds render only approved ideas and add to the job's earlier clips.
"""

import asyncio
import json

import pytest

from clip_engine.error_policy import safe_failure_code, safe_processing_error
from clip_engine.services import ai_clipping_pipeline as pipeline_module
from clip_engine.services.ai_clipping_pipeline import (
    AIClippingPipeline,
    ClippingJobRequest,
    JobStatus,
    ReviewStateError,
)
from clip_engine.services.intelligence_planner import ClipPlanResponse, ClipPlanSegment, PlanningApiCosts
from clip_engine.services.rendering_service import RenderingService, RenderResult
from clip_engine.services.transcription_service import (
    TranscriptionApiCosts,
    TranscriptionResult,
    TranscriptSegment,
    TranscriptWord,
)
from clip_engine.services.video_downloader import DownloadResult, VideoMetadata


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    settings = pipeline_module.get_settings()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))
    monkeypatch.setattr(settings.__class__, "temp_directory", property(lambda self: str(tmp_path / "work")))
    calls = {"download": 0, "transcribe": 0, "plan": [], "render": []}

    def make_pipeline():
        pipeline = AIClippingPipeline()
        pipeline.local_mode = True

        async def download(url, output_dir):
            calls["download"] += 1
            path = f"{output_dir}/downloaded.mkv"
            with open(path, "wb") as f:
                f.write(b"source video")
            meta = VideoMetadata(title="Stream", duration_seconds=600.0, width=1920, height=1080,
                                 fps=30.0, format_id="x", extractor="youtube")
            return DownloadResult(video_path=path, metadata=meta, file_size_bytes=12, source_type="youtube")

        async def transcribe(video_path, work_dir, keyterms=None, **_range):
            calls["transcribe"] += 1
            segments = [
                TranscriptSegment(i * 10_000, i * 10_000 + 9_000, f"line {i}.", words=[
                    TranscriptWord(f"line{i}", i * 10_000, i * 10_000 + 4_000),
                    TranscriptWord(f"end{i}.", i * 10_000 + 4_000, i * 10_000 + 9_000),
                ])
                for i in range(60)
            ]
            return TranscriptionResult(
                segments=segments, full_text="...",
                api_costs=TranscriptionApiCosts(model="m", audio_duration_seconds=600, estimated_cost_usd=0.01),
            )

        async def plan(**kwargs):
            calls["plan"].append(kwargs)
            segments = [
                ClipPlanSegment(i * 60_000, i * 60_000 + 30_000, 0.9 - i * 0.1, summary=f"Idea {i}",
                                pitch=f"Pitch {i}.", scores={"hook": 9 - i}, idea_id=f"idea-0{i + 1}",
                                rank=i + 1, recommended=i < 2,
                                # Idea 2 has a cold open: the line at 70-74 s inside its window.
                                hook_start_ms=70_000 if i == 1 else None, hook_end_ms=74_000 if i == 1 else None,
                                hook_text="line7 end7." if i == 1 else None)
                for i in range(4)
            ]
            return ClipPlanResponse(segments=segments, total_clips=4, recommended_count=2,
                                    api_costs=PlanningApiCosts(model="p", estimated_cost_usd=0.02))

        async def render(request):
            calls["render"].append(request.start_time_ms)
            open(request.output_path, "wb").write(b"mp4")
            return RenderResult(output_path=request.output_path, file_size_bytes=3, duration_ms=30_000,
                                layout_cost_usd=0.001)

        monkeypatch.setattr(pipeline.video_downloader, "download_video", download)
        monkeypatch.setattr(pipeline.transcription_service, "transcribe", transcribe)
        monkeypatch.setattr(pipeline.intelligence_planner, "plan_clips", plan)
        monkeypatch.setattr(pipeline.rendering_service, "render_clip", render)
        monkeypatch.setattr(pipeline, "_update_progress", lambda *a, **k: None)
        return pipeline

    return make_pipeline, calls, tmp_path


def run(pipeline, **fields):
    return asyncio.run(pipeline.process_video(ClippingJobRequest(video_url="https://x.test/v", job_id="job1", **fields)))


def test_analyze_keeps_the_source_saves_ideas_and_renders_nothing(env):
    make_pipeline, calls, tmp = env
    result = run(make_pipeline(), phase="analyze")

    assert result.status == JobStatus.AWAITING_APPROVAL, result.error
    assert calls["plan"][0]["review_mode"] is True
    assert calls["render"] == []
    run_dir = tmp / "out" / "job1"
    assert not (run_dir / "job_output.json").exists()
    assert not (tmp / "work" / "job1").exists()
    assert (run_dir / "source.mkv").read_bytes() == b"source video"

    review = json.loads((run_dir / "review.json").read_text())
    assert review["source"] == {"path": str(run_dir / "source.mkv"), "downloaded": True, "size_bytes": 12}
    assert review["recommended_count"] == 2
    assert review["api_costs"]["transcription"]["estimated_cost_usd"] == 0.01
    assert review["api_costs"]["planning"]["estimated_cost_usd"] == 0.02
    ideas = review["ideas"]
    assert [i["idea_id"] for i in ideas] == ["idea-01", "idea-02", "idea-03", "idea-04"]
    assert [i["recommended"] for i in ideas] == [True, True, False, False]
    assert ideas[1]["pitch"] == "Pitch 1." and ideas[1]["summary"] == "Idea 1"
    assert ideas[1]["excerpt"].startswith("line6 end6. line7 end7.")
    assert not any(i["rendered"] for i in ideas)


def test_render_rounds_render_only_approved_ideas_and_add_to_earlier_clips(env):
    make_pipeline, calls, tmp = env
    run(make_pipeline(), phase="analyze")
    run_dir = tmp / "out" / "job1"

    first = run(make_pipeline(), phase="render", approved_idea_ids=["idea-02", "idea-04"])
    assert first.status == JobStatus.COMPLETED, first.error
    assert calls["download"] == 1 and calls["transcribe"] == 1 and len(calls["plan"]) == 1
    assert sorted(calls["render"]) == [60_000, 180_000]
    assert [(c.clip_index, c.idea_id) for c in first.output.clips] == [(0, "idea-02"), (1, "idea-04")]
    costs = first.output.metrics["api_costs"]
    assert costs["total_estimated_cost_usd"] == pytest.approx(0.032)
    assert (run_dir / "source.mkv").exists()

    second = run(make_pipeline(), phase="render", approved_idea_ids=["idea-01"])
    assert second.status == JobStatus.COMPLETED, second.error
    manifest = json.loads((run_dir / "job_output.json").read_text())
    assert [(c["clip_index"], c["idea_id"]) for c in manifest["clips"]] == [(0, "idea-02"), (1, "idea-04"), (2, "idea-01")]
    assert manifest["total_clips"] == 3
    assert (run_dir / "clip_02.mp4").exists()
    assert manifest["metrics"]["api_costs"]["layout_vision"]["estimated_cost_usd"] == pytest.approx(0.003)
    review = json.loads((run_dir / "review.json").read_text())
    assert {i["idea_id"]: i["clip_index"] for i in review["ideas"] if i["rendered"]} == {
        "idea-01": 2, "idea-02": 0, "idea-04": 1,
    }


def test_render_refuses_rendered_unknown_ideas_and_a_deleted_source(env):
    make_pipeline, _, tmp = env
    run(make_pipeline(), phase="analyze")
    run(make_pipeline(), phase="render", approved_idea_ids=["idea-01"])

    again = run(make_pipeline(), phase="render", approved_idea_ids=["idea-01"])
    assert again.status == JobStatus.FAILED
    assert again.error == "An approved idea has already been rendered"
    unknown = run(make_pipeline(), phase="render", approved_idea_ids=["idea-09"])
    assert unknown.error == "An approved idea is not part of this job"

    (tmp / "out" / "job1" / "source.mkv").unlink()
    gone = run(make_pipeline(), phase="render", approved_idea_ids=["idea-02"])
    assert gone.error == "The source video for this job is no longer available"
    assert gone.failure_code == "review.unavailable"
    manifest = json.loads((tmp / "out" / "job1" / "job_output.json").read_text())
    assert [c["idea_id"] for c in manifest["clips"]] == ["idea-01"]


def test_render_phase_requires_approved_ideas_and_a_known_phase():
    with pytest.raises(ValueError):
        ClippingJobRequest(video_url="v", phase="render")
    with pytest.raises(ValueError):
        ClippingJobRequest(video_url="v", phase="later")


def test_review_errors_are_exposed_as_fixed_messages():
    error = ReviewStateError("The source video for this job is no longer available")
    assert safe_processing_error(error) == "The source video for this job is no longer available"
    assert safe_failure_code(error) == "review.unavailable"
    assert safe_processing_error(ReviewStateError("/private/path leaked")) == "Processing failed"


def cold_open_pipeline(make_pipeline, monkeypatch, *, fail=False):
    pipeline = make_pipeline()
    joins = []

    async def join(hook_path, body_path, output_path, **kwargs):
        joins.append({"hook": hook_path, "body": body_path, **kwargs})
        if fail:
            raise RuntimeError("join failed")
        open(output_path, "wb").write(b"hook+mp4")

    monkeypatch.setattr(pipeline.rendering_service, "join_cold_open", join)
    return pipeline, joins


def test_approved_cold_open_renders_the_hook_and_puts_it_in_front(env, monkeypatch):
    make_pipeline, calls, tmp = env
    run(make_pipeline(), phase="analyze")
    review = json.loads((tmp / "out" / "job1" / "review.json").read_text())
    idea = review["ideas"][1]
    assert (idea["hook_start_ms"], idea["hook_end_ms"], idea["hook_text"]) == (70_000, 74_000, "line7 end7.")

    requests = []
    pipeline, joins = cold_open_pipeline(make_pipeline, monkeypatch)
    original = pipeline.rendering_service.render_clip

    async def spy(request):
        requests.append(request)
        return await original(request)

    monkeypatch.setattr(pipeline.rendering_service, "render_clip", spy)
    result = run(pipeline, phase="render", approved_idea_ids=["idea-02", "idea-04"], hook_idea_ids=["idea-02"])

    assert result.status == JobStatus.COMPLETED, result.error
    assert sorted(calls["render"]) == [60_000, 70_000, 180_000], "idea-02 twice (clip and hook), idea-04 once"
    hook_request = next(r for r in requests if r.start_time_ms == 70_000)
    assert (hook_request.end_time_ms, hook_request.pacing, hook_request.skip_ranges_ms, hook_request.chapters) == (74_000, "natural", [], [])
    assert hook_request.title_text == "Idea 1", "a vertical title stays on screen through the hook"
    assert [t.start_time_ms for t in hook_request.transcript_segments] == [70_000], "captions come from the hook's own words"
    assert len(joins) == 1 and joins[0]["hook_ms"] == 30_000 and joins[0]["body_ms"] == 30_000
    clips = {c.idea_id: c for c in result.output.clips}
    assert clips["idea-02"].duration_ms == 60_000, "the clip is now hook plus clip"
    assert clips["idea-04"].duration_ms == 30_000
    assert (tmp / "out" / "job1" / f"clip_{clips['idea-02'].clip_index:02d}.mp4").read_bytes() == b"hook+mp4"
    assert (tmp / "out" / "job1" / f"clip_{clips['idea-04'].clip_index:02d}.mp4").read_bytes() == b"mp4"


def test_a_cold_open_is_only_made_for_ideas_the_user_ticked(env, monkeypatch):
    make_pipeline, calls, _ = env
    run(make_pipeline(), phase="analyze")
    pipeline, joins = cold_open_pipeline(make_pipeline, monkeypatch)
    result = run(pipeline, phase="render", approved_idea_ids=["idea-02"])
    assert result.status == JobStatus.COMPLETED, result.error
    assert calls["render"] == [60_000] and joins == []
    assert result.output.clips[0].duration_ms == 30_000


def test_a_failed_cold_open_keeps_the_clip_as_rendered(env, monkeypatch):
    make_pipeline, calls, tmp = env
    run(make_pipeline(), phase="analyze")
    pipeline, joins = cold_open_pipeline(make_pipeline, monkeypatch, fail=True)
    result = run(pipeline, phase="render", approved_idea_ids=["idea-02"], hook_idea_ids=["idea-02"])
    assert result.status == JobStatus.COMPLETED, result.error
    assert len(joins) == 1
    (clip,) = result.output.clips
    assert clip.duration_ms == 30_000
    run_dir = tmp / "out" / "job1"
    assert (run_dir / "clip_00.mp4").read_bytes() == b"mp4"
    assert not [p for p in (tmp / "work").rglob("*") if "_hook" in p.name or "_joined" in p.name], "no leftovers"


def test_cold_opens_need_approved_ideas():
    with pytest.raises(ValueError, match="approved ideas"):
        ClippingJobRequest(video_url="https://x.test/v", phase="render", approved_idea_ids=["idea-01"], hook_idea_ids=["idea-02"])
