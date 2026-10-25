// The report-type seam (volumetric report spec, section 8): one template per report type behind
// one interface. The editor, the export plumbing (PDF, HTML), the text file and the pictures are
// written against it; a new project type adds a template and a `ReportTypeId` value, nothing else.
// A template's pages are React components printed with `renderToStaticMarkup` by the hidden report
// window and rendered live by the editor's preview, so both show the same markup.
import type { PlannedPage } from '@aio/project/export';
import type {
  ProjectManifest,
  ReportPageId,
  ReportTypeId,
  ReportView,
  ReportViewKind,
  ReportViewsFrame,
} from '@aio/schema';
import type { ReactElement } from 'react';
import type { SurveyFiles } from '../house/surveyData';

/** The texts as resolved for one layout: each part's text (the person's or generated). */
export interface ResolvedText {
  /** By part id (`VolumetricTextId` for the volumetric report). A missing part is generated. */
  parts: Readonly<Partial<Record<string, string>>>;
  /** A note per pile, by measurement id. */
  pileNotes: Readonly<Record<string, string>>;
}

/** The report's saved pictures, as the page can show them. */
export interface ReportViews {
  /** The pictures' framing (`frame.json`), or null when none are taken yet. */
  frame: ReportViewsFrame | null;
  /**
   * The URL of a picture (`data:` in the HTML file, the project's file in the PDF and preview),
   * or null when the frame has no such picture. `pair` is the compared date of a `cutfill` view.
   */
  picture(kind: ReportViewKind, capture: string, pair?: string): string | null;
  /** The URL of a pile's crop JPEG on a date (the PDF's separate crops), or null. */
  crop?(pile: string, capture: string): string | null;
}

/** What a page component gets: the model, the texts, the pictures and where it sits. */
export interface PageContext<Model> {
  model: Model;
  text: ResolvedText;
  views: ReportViews;
  /** This printed page (which report page, continued or not, its rows and number). */
  page: PlannedPage;
  /** Printed pages in all. */
  total: number;
}

/** One report page's component (A, B or C), registered on its template. */
export type PageComponent<Model> = (ctx: PageContext<Model>) => ReactElement;

/** One printed A4 page: its place in the page plan and its markup. */
export interface RenderedPage extends PlannedPage {
  element: ReactElement;
}

export type ReportPages = RenderedPage[];

export interface ReportTemplate<Model, Input> {
  id: ReportTypeId;
  /** Whether the Reports screen offers this report for the project. */
  offered(project: { manifest: ProjectManifest; survey: SurveyFiles | null }): boolean;
  /** The editable text parts, in editor order. */
  textParts: readonly string[];
  /** The report pages the template knows, in print order. */
  pages: readonly ReportPageId[];
  /** Pure, from the app's figures. */
  model(input: Input): Model;
  /** The printed A4 pages the model, the texts and the page switches give. */
  render(model: Model, text: ResolvedText, views: ReportViews): ReportPages;
}

/** Report views over a frame and a resolver from a picture's file name to its URL. */
export function reportViews(
  frame: ReportViewsFrame | null,
  url: (file: string) => string | null,
  crop?: (pile: string, capture: string) => string | null,
): ReportViews {
  const find = (kind: ReportViewKind, capture: string, pair?: string): ReportView | undefined =>
    frame?.views.find(
      (v) => v.kind === kind && v.capture === capture && (pair === undefined || v.pair === pair),
    );
  return {
    frame,
    picture: (kind, capture, pair) => {
      const v = find(kind, capture, pair);
      return v ? url(v.file) : null;
    },
    ...(crop ? { crop } : {}),
  };
}

/** No pictures: every page shows its placeholder. */
export const NO_VIEWS: ReportViews = reportViews(null, () => null);
