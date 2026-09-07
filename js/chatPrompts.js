// js/chatPrompts.js
// ---------------------------------------------------------------------------
// Predefined quick-prompt presets for the Chat panel. Kept in its own module,
// deliberately separate from ui.js/main.js, so adding, editing, or reordering
// a preset is a one-line data change here — never a reason to touch
// rendering or orchestration logic elsewhere. ui.js just renders whatever is
// in this array; nothing else needs to know these exist.
// ---------------------------------------------------------------------------

export const CHAT_PROMPT_PRESETS = [
  {
    label: "Follow-up questions",
    prompt: "Give me follow-up questions and concise key answers based on this meeting.",
  },
  {
    label: "List interview questions",
    prompt: "List out all of the interview questions asked during this meeting, in the order they were asked.",
  },
  {
    label: "Evaluate candidate",
    prompt: "Evaluate the candidate based on the interview context — strengths, weaknesses, and an overall recommendation.",
  },
];
