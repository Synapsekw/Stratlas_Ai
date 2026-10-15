import { appHooks, define, project, ToolError } from './tool-kit';

/*
 * propose_class (ANN-7): the assistant proposes a class, the agent card asks the person
 * (risk `write`), and only then does the app create it. A name the project has is returned.
 */
define('propose_class', async (input, ctx) => {
  const label = input.label.trim();
  const classes = project(ctx).manifest.classCatalogues.flatMap((c) => c.classes);
  const same = classes.find((c) => c.label.trim().toLowerCase() === label.toLowerCase());
  if (same) {
    return {
      result: { classId: same.id, label: same.label, created: false },
      summary: `Class ${same.label} exists already`,
    };
  }
  const create = appHooks.createClass;
  if (!create) throw new ToolError('This app cannot create classes.');
  const cls = await create(label);
  return {
    result: { classId: cls.id, label: cls.label, created: true },
    summary: `Created class ${cls.label}`,
  };
});
