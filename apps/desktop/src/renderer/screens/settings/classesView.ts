import { classUsage } from '@aio/annotate';
import type { ClassCatalogue, IssueClass, SeverityModel } from '@aio/schema';

export interface ClassRow {
  cls: IssueClass;
  issues: number;
  detections: number;
  /** The severity model's name, or its id when the project does not have it. */
  modelName: string;
}

export function classRows(
  catalogues: readonly ClassCatalogue[],
  models: readonly SeverityModel[],
  issues: readonly { classId: string }[],
  detections: readonly { classId: string; status: string }[],
): ClassRow[] {
  return catalogues.flatMap((c) =>
    c.classes.map((cls) => ({
      cls,
      ...classUsage(issues, detections, cls.id),
      modelName: models.find((m) => m.id === cls.severityModel)?.name ?? cls.severityModel,
    })),
  );
}

/** The classes that can take over the issues and detections of class `id`. */
export function moveTargets(rows: readonly ClassRow[], id: string): IssueClass[] {
  return rows.filter((r) => r.cls.id !== id).map((r) => r.cls);
}
