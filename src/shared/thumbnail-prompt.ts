/**
 * The prompt sent to the image model for AI thumbnails. Users can edit it in
 * Settings; placeholders in {braces} are filled per clip.
 *
 * The default follows what 2026 thumbnail studies found works on YouTube and
 * Shorts: one large, expressive face (in most breakout videos), a single
 * focal point, bold high-contrast colour, and 2–5 huge words that add
 * curiosity instead of repeating the title.
 */
export const THUMBNAIL_PLACEHOLDERS = ['title', 'pitch', 'description', 'format'] as const
export type ThumbnailPromptVars = Record<(typeof THUMBNAIL_PLACEHOLDERS)[number], string>

export const DEFAULT_THUMBNAIL_MODEL = 'google/gemini-3.1-flash-image'

export const DEFAULT_THUMBNAIL_PROMPT = `Create a scroll-stopping video thumbnail ({format}) for this clip.

Video title: {title}
What happens: {pitch}
Details: {description}

The attached images are real frames from the video. Use them as the reference for the person.

PERSON (most important)
- The person from the frames is the single hero of the thumbnail: large, sharp, filling about 40-60% of the frame.
- Keep their face, hair, skin and clothing recognisably the same person. Do not beautify, swap or invent a different face.
- Give them a strong, exaggerated emotion that fits the topic (surprise, excitement, disbelief, focus), with a clear facial expression that reads at phone size.
- Show them doing or reacting to the key moment of the clip, not just posing.

BACKGROUND AND COMPOSITION
- One clear focal point. Simplify the background: blur, darken or replace it with a clean, relevant scene or a bold colour gradient. It may be generated.
- Add at most one supporting visual element that hints at the topic (an object, an arrow, a before/after contrast).
- Bold, saturated, high-contrast colours; the person clearly separated from the background (rim light or glow).
- Keep the face and text inside the centre safe zone; nothing important at the very edges or in the bottom-right corner.

TEXT
- 2 to 5 words, huge, thick sans-serif, with a strong outline or drop shadow, readable on a small phone screen.
- The text must create curiosity or promise a payoff. Do NOT repeat the title; add the hook the title leaves out. Use a number if one fits naturally.
- Write the text in the same language as the video title. Spell every word correctly.
- Place the text beside the face, never covering it.

AVOID
- Small or extra text, logos, watermarks, UI elements, borders, collages of many faces, cluttered backgrounds, misleading content that the clip does not deliver.`

/** Fill {placeholders}; unknown ones are left as written so users see what went wrong. */
export function fillThumbnailPrompt(template: string, vars: ThumbnailPromptVars): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key as keyof ThumbnailPromptVars] : match)
}
