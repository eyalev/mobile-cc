// Workflow contract type, in JSDoc form so editors get hints without
// a TypeScript build step in this dir.

/**
 * @typedef {Object} WorkflowCtx
 * @property {import('playwright').Page} page
 *   The live Playwright page, already navigated to the daemon.
 * @property {(ms: number) => Promise<void>} idle
 *   Wait `ms` milliseconds. Use for pacing the recording.
 * @property {(label: string) => Promise<void>} recordStep
 *   Mark a beat in steps.json — records the current ms-offset + label.
 *   Used in the per-workflow page to annotate the timeline.
 * @property {(pngPath: string) => Promise<void>} dispatchPaste
 *   Dispatch a synthetic ClipboardEvent on #input-text carrying the
 *   PNG bytes. Exercises ttyview-image-paste's onPaste handler.
 * @property {(text: string, opts?: { delay?: number }) => Promise<void>} typeCaption
 *   Type into #input-text at human pace (default 80ms/char).
 * @property {() => Promise<void>} pressSend
 *   Click #send-btn.
 * @property {(name: string) => Promise<void>} stillSnapshot
 *   Take a hero still PNG at this moment, written as <id>-<name>.png
 *   next to the video.
 */

/**
 * @typedef {Object} Workflow
 * @property {string} id        kebab-case, becomes dist/demos/<id>/
 * @property {string} title     human-readable
 * @property {string} description  one-paragraph
 * @property {(ctx: WorkflowCtx) => Promise<void>} run
 * @property {(ctx: WorkflowCtx) => Promise<void>} validate
 */

export const WORKFLOW_CONTRACT = 'v1';
