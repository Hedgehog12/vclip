"""
Cold open: a line from inside a clip plays first as the hook, then the clip
plays from its normal start, so that line is heard twice.

The renderer assumes every moment of a clip appears once (captions, framing and
chapters all depend on that), so the hook is rendered as its own short clip and
joined in front of the finished one. The helpers here move what belonged to the
finished clip (chapters, subtitles) onto the longer timeline.
"""

import re

_SRT_BLOCK = re.compile(
    r"(?:^|\n)\s*\d+\s*\n(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})[^\n]*\n(.*?)(?=\n\s*\n|\Z)",
    re.DOTALL,
)


def shift_chapters(chapters: list[tuple[int, str]], offset_ms: int) -> list[tuple[int, str]]:
    """Chapters of the finished clip, on the timeline that starts with the hook.

    YouTube needs the first chapter at 0:00, so it stays there and now also
    covers the hook; the later ones move back by the hook's length.
    """
    return [(0 if index == 0 else start_ms + offset_ms, title) for index, (start_ms, title) in enumerate(chapters)]


def _timestamp(ms: int) -> str:
    ms = max(0, int(ms))
    return f"{ms // 3_600_000:02d}:{ms // 60_000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def _cues(srt: str) -> list[tuple[int, int, str]]:
    cues = []
    for match in _SRT_BLOCK.finditer(srt.replace("\r\n", "\n")):
        h1, m1, s1, ms1, h2, m2, s2, ms2 = (int(match.group(i)) for i in range(1, 9))
        text = match.group(9).strip()
        if text:
            cues.append((((h1 * 60 + m1) * 60 + s1) * 1000 + ms1, ((h2 * 60 + m2) * 60 + s2) * 1000 + ms2, text))
    return cues


def merge_srt(hook_srt: str, body_srt: str, hook_ms: int) -> str:
    """The hook's subtitles, then the clip's moved back by the hook's length."""
    cues = _cues(hook_srt) + [(start + hook_ms, end + hook_ms, text) for start, end, text in _cues(body_srt)]
    return "".join(
        f"{number}\n{_timestamp(start)} --> {_timestamp(end)}\n{text}\n\n"
        for number, (start, end, text) in enumerate(cues, start=1)
    )
