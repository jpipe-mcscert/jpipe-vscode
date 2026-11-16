/**
 * The zoom setting both diagram panels read, the preview's and the run panel's: one canvas, one
 * feel. No VS Code, so it is tested.
 */

/** The setting, under `jpipe.`. */
export const ZOOM_SENSITIVITY_SETTING = 'previewZoomSensitivity';

const MIN = 0.25;
const MAX = 4;

/**
 * The multiplier the page is given. The range is guarded here as well as in the schema: a
 * hand-edited settings.json can hold anything, and a zero or negative multiplier would break
 * zooming outright.
 */
export function clampZoomSensitivity(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX, Math.max(MIN, value)) : 1;
}
