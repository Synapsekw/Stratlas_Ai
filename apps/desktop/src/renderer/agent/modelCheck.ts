/**
 * Whether the open project has a procedural or engineering model, for the agent's tool list (the
 * modelling and correction tools are offered only where they can work). The Model builder registers
 * how to find out (`setAgentModelCheck`); the answer is kept per project until a model is written
 * (`forgetAgentModelCheck`, called after `model:write`), and a slow answer counts as unknown, so a
 * message never waits long for it. Unknown keeps the tools.
 */

/** How long a message waits for the answer before it goes with "unknown". */
export const MODEL_CHECK_MS = 1500;

export interface ModelCheckSource {
  /** True when a model is open now (the Model builder, an engineering correction host). */
  now(): boolean;
  /** Whether the project has a saved model; undefined when that cannot be read. */
  saved(projectId: string): Promise<boolean | undefined>;
}

export interface ModelCheck {
  has(projectId: string | undefined): Promise<boolean | undefined>;
  forget(): void;
}

export function createModelCheck(
  source: () => ModelCheckSource | null,
  timeoutMs = MODEL_CHECK_MS,
): ModelCheck {
  let known: { projectId: string; has: boolean } | null = null;
  return {
    async has(projectId) {
      const s = source();
      if (!s || !projectId) return undefined;
      if (s.now()) return true;
      if (known?.projectId === projectId) return known.has;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
        }, timeoutMs);
      });
      try {
        const has = await Promise.race([s.saved(projectId).catch(() => undefined), late]);
        if (has !== undefined) known = { projectId, has };
        return has;
      } finally {
        clearTimeout(timer);
      }
    },
    forget() {
      known = null;
    },
  };
}

let source: ModelCheckSource | null = null;
const check = createModelCheck(() => source);

/** The Model builder tells the agent how to find out whether the project has a model. */
export function setAgentModelCheck(next: ModelCheckSource | null): void {
  source = next;
  check.forget();
}

/** A model was written: the next message asks again. */
export function forgetAgentModelCheck(): void {
  check.forget();
}

/** Whether the project has a model; undefined when unknown (the modelling tools stay). */
export function agentHasModel(projectId: string | undefined): Promise<boolean | undefined> {
  return check.has(projectId);
}
