import type { LibraryClass, SeverityTemplate } from '@aio/schema';

const key = (s: string) => s.trim().toLowerCase();

/** The class library as wizard choices; classes the template brings already are marked. */
export function libraryChoices(
  lib: readonly LibraryClass[],
  template: SeverityTemplate | undefined,
): { cls: LibraryClass; inTemplate: boolean }[] {
  const has = new Set((template?.catalogue?.classes ?? []).map((c) => key(c.label)));
  return lib.map((cls) => ({ cls, inTemplate: has.has(key(cls.label)) }));
}

/** The ticked library classes to add to the new project (not those the template has). */
export function pickedEntries(
  lib: readonly LibraryClass[],
  picked: ReadonlySet<string>,
  template: SeverityTemplate | undefined,
): LibraryClass[] {
  return libraryChoices(lib, template)
    .filter((c) => !c.inTemplate && picked.has(c.cls.label))
    .map((c) => c.cls);
}
