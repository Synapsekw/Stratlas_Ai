/** Main-process exclusion covering asynchronous starts as well as live runtimes. */
export function createUpdateWorkGate(live: () => boolean = () => false) {
  let pending = 0;
  let restarting = false;
  let workRefusal: string | null = null;
  return {
    blockWork(reason: string | null) {
      workRefusal = reason;
    },
    enter() {
      if (workRefusal) throw new Error(workRefusal);
      if (restarting) throw new Error('An update restart is in progress.');
      pending++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          pending--;
        }
      };
    },
    busy() {
      return pending > 0 || live();
    },
    acquire() {
      if (restarting || pending > 0 || live()) return null;
      restarting = true;
      return () => {
        restarting = false;
      };
    },
  };
}
export type UpdateWorkGate = ReturnType<typeof createUpdateWorkGate>;
