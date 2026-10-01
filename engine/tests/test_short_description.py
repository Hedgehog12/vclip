"""Short clips get a post description: keyword sentences, then hashtags."""

import json

from clip_engine.services.intelligence_planner import clip_plan_schema
from tests.test_planner import clip, completion, make_planner, make_transcript


def test_every_clip_asks_for_a_description_once():
    for longform in (False, True):
        required = clip_plan_schema(longform)["properties"]["clips"]["items"]["required"]
        assert required.count("description") == 1, longform


def test_short_clips_keep_their_keyword_description_and_hashtags():
    planner = make_planner()
    planner._current_transcript = make_transcript(300).segments
    planner._current_duration_ranges = ["short"]
    item = {**clip(60, 100), "pitch": "p", "emphasis": [], "hook_start": -1, "hook_end": -1,
            "description": "  Why Claude Code should never write your commit messages.\n\n#ai #claudecode #git  "}
    response = completion(json.dumps({"insights": "x", "clips": [item]}))
    (segment,) = planner._parse_clip_plan_response(response).segments
    assert segment.description == "Why Claude Code should never write your commit messages.\n\n#ai #claudecode #git"


def test_the_short_prompt_explains_keywords_and_hashtags():
    prompt = make_planner()._build_system_prompt(3, 30, 60)
    assert "## DESCRIPTION" in prompt and "hashtags" in prompt


def test_clips_carry_a_valid_youtube_category_and_drop_unknown_ones():
    from clip_engine.services.intelligence_planner import CLIP_PLAN_SCHEMA, YOUTUBE_CATEGORIES
    item_schema = CLIP_PLAN_SCHEMA["properties"]["clips"]["items"]
    assert "category" in item_schema["required"]
    assert set(item_schema["properties"]["category"]["enum"]) == set(YOUTUBE_CATEGORIES)
    planner = make_planner()
    planner._current_transcript = make_transcript(300).segments
    planner._current_duration_ranges = ["short"]
    base = {**clip(60, 100), "pitch": "p", "emphasis": [], "hook_start": -1, "hook_end": -1, "description": "d"}
    for category, expected in (("28", "28"), ("999", None), (28, None)):
        response = completion(json.dumps({"insights": "x", "clips": [{**base, "category": category}]}))
        (segment,) = planner._parse_clip_plan_response(response).segments
        assert segment.youtube_category == expected, category


def test_the_prompts_explain_search_tags_and_category():
    planner = make_planner()
    for prompt in (planner._build_system_prompt(3, 30, 60), planner._build_longform_system_prompt(3, 600, 900)):
        assert '"category"' in prompt and "28" in prompt
        assert "YouTube tags" in prompt or "keyword tags" in prompt
