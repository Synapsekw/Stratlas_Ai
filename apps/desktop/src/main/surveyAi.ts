/**
 * **Suggest boundaries** (M11 stream G12, ADR 0011): a draft outline around a click on an ortho
 * crop the renderer sends, from the local segmentation model in the pipeline pack, a draft until
 * a person accepts it. Nothing leaves the computer. Without the pack or its model, `status` says
 * why and `suggest` answers with code `unavailable` and the same words.
 */
import type { Handle } from './notYet';
import type { Segmenter } from './inference/segment';

export interface SurveyAiIpcDeps {
  handle: Handle;
  segmenter: Segmenter;
}

export function registerSurveyAiIpc({ handle, segmenter }: SurveyAiIpcDeps): void {
  handle('surveyAi:status', () => segmenter.status());
  handle('surveyAi:suggest', (req) =>
    segmenter.suggest({
      click: req.click,
      crop: req.crop,
      refine: req.refine,
      bufferPx: req.bufferPx,
      vertices: req.vertices,
    }),
  );
}
