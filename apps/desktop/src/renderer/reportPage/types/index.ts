// The report templates, one per report type (spec section 8). The volumetric template's pages
// are collected from their own modules: `volumetric/cover.tsx`, `piles.tsx` and `change.tsx` each
// export `volumetricPage` ({ id, component }), so a page registers itself by existing and no two
// page tasks edit this file. A page without a component is left out of the print (and of the
// page numbers) until it lands.
import {
  pagePlan,
  volumetricModel,
  type VolumetricInput,
  type VolumetricModel,
} from '@aio/project/export';
import { ReportPageId, VolumetricTextId } from '@aio/schema';
import { createElement } from 'react';
import { stockpileItem } from '../house/surveyData';
import type { PageComponent, RenderedPage, ReportTemplate } from './template';

export type * from './template';
export { NO_VIEWS, reportViews } from './template';

interface PageModule {
  volumetricPage?: { id: ReportPageId; component: PageComponent<VolumetricModel> };
}

const modules = import.meta.glob<PageModule>('../volumetric/{cover,piles,change}.tsx', {
  eager: true,
});

/** The volumetric report's page components, by report page. */
export const VOLUMETRIC_PAGES: Partial<Record<ReportPageId, PageComponent<VolumetricModel>>> =
  Object.fromEntries(
    Object.values(modules)
      .map((m) => m.volumetricPage)
      .filter((p) => p !== undefined)
      .map((p) => [p.id, p.component]),
  );

export const volumetricTemplate: ReportTemplate<VolumetricModel, VolumetricInput> = {
  id: 'volumetric',
  offered: ({ survey }) => survey?.measurements.some((m) => stockpileItem(m) !== null) ?? false,
  textParts: VolumetricTextId.options,
  pages: ReportPageId.options,
  model: volumetricModel,
  render(model, text, views) {
    const on = Object.fromEntries(
      ReportPageId.options.map((id) => [id, model.pages[id] && VOLUMETRIC_PAGES[id] !== undefined]),
    );
    const plan = pagePlan(model, on);
    return plan.flatMap((page): RenderedPage[] => {
      const component = VOLUMETRIC_PAGES[page.page];
      if (!component) return [];
      return [
        {
          ...page,
          element: createElement(component, { model, text, views, page, total: plan.length }),
        },
      ];
    });
  },
};

export const REPORT_TEMPLATES = { volumetric: volumetricTemplate } as const;
