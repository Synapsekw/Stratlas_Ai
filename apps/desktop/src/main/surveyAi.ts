/**
 * **Suggest boundaries** (M11 stream G12): a draft outline around a click on an ortho layer, from
 * the local segmentation model, a draft until a person accepts it. Nothing leaves the computer.
 * G0 stub: the channel answers "not available yet".
 */
import { notYet, type Handle } from './notYet';

export interface SurveyAiIpcDeps {
  handle: Handle;
}

export function registerSurveyAiIpc({ handle }: SurveyAiIpcDeps): void {
  handle('surveyAi:suggest', () => notYet('Suggest boundaries'));
}
