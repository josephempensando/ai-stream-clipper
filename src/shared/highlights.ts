import type { Highlight } from './types.js';

// Timing aliases always derive from the validated source interval, including edits.
export function highlightDetails(highlight: Highlight): Highlight {
  return {
    ...highlight, startTime: highlight.start, endTime: highlight.end,
    duration: highlight.end - highlight.start,
    aiSelectedDuration: highlight.aiSelectedDuration ?? highlight.end - highlight.start,
    description: highlight.description || highlight.transcript.slice(0, 1200) || highlight.title,
    reasonForSelection: highlight.explanation, engagementScore: highlight.score,
  };
}
