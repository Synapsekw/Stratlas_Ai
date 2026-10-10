# /roast: an adversarial council stress-tests an idea or decision before work starts

Pull Claude out of agreement mode (sycophancy) and **stress-test the user's idea or decision before
any work is committed**. Instead of one model judging, and talking itself into agreement, spin up
a council of adversarial persona sub-agents **in parallel**, each attacking from a different angle,
then a **separate Judge** synthesizes their findings into one verdict.

**Core principle:** the worker does not get to grade itself. The personas generate; a _different_
agent judges. Relay the Judge's verdict, do not author it yourself.

Invoked as `/roast <the idea or decision>`. If no argument was given, ask the user for the one-line
idea/decision first, then proceed.

## Steps to follow

Create a TodoWrite item per step and work them in order.

### 1. Detect mode

Classify the input as one of:

- **`idea`**: a business / product / monetization idea ("a $9/mo tool that turns transcripts into
  LinkedIn posts", "should we charge for X", "is this a viable product").
- **`technical`**: an engineering / architecture / process / tooling decision ("adopt library X",
  "is this migration plan sound", "split this service", "switch to Y pattern").

State the call in one line (e.g. `Mode: technical`). If the user's message overrides it ("treat
this as an idea"), honor the override.

### 2. Intake gate: ask up to 3 mode-aware questions

Using `AskUserQuestion`, ask **at most 3** sharp clarifying questions. **Skip any question the
brief already answers**, never ask what the user already stated.

- **idea mode:** (a) who is the actual target buyer? (b) what is your edge / what do you already
  have, distribution, audience, assets? (c) constraints & budget, how fast to first dollar?
- **technical mode:** (a) what does "good" look like / what's the goal? (b) hard constraints:
  stack, deadlines, offline-first, Windows, performance budgets, team size? (c) what alternatives have you already
  considered or rejected?

### 3. Assemble the brief

Compose a compact, structured **brief block**, the single source the whole council judges against.
Include: the raw input, the intake answers, and the detected mode. Every persona and the Judge
receive this verbatim.

### 4. Fan-out: dispatch 5 persona agents in ONE parallel batch

Dispatch **all five persona agents in a single message** (one `Agent` tool call per persona, all in
the same message, this is what makes them run concurrently). Use `subagent_type: general-purpose`
(it has web + read access). Give each agent the brief + its persona rubric + the **required output
schema**.

**Required output schema**, instruct every persona agent to return exactly:

```
SCORE: <n>/10
TOP FINDINGS:
- <2 to 4 bullets>
THE ONE THING THAT MATTERS MOST: <one line>
VERDICT-LEAN: green | reshape | kill
```

**Roster, pick the 5 for the detected mode:**

- **Contrarian** (both): Your only job is to find the fatal flaws, the reasons this dies. Be
  ruthless. Assume it fails and explain why. Do not hedge or balance; that's another agent's job.
- **Expansionist** (both): Find the biggest upside, the glass-half-full read. If this works, how
  big could it get? What's the most ambitious version worth pursuing?
- **First-Principles** (both): Reason from pure logic with **no outside/market/repo context**:
  judge only the internal coherence of the idea on its own terms. (Give this agent the brief but
  explicitly tell it NOT to research or assume external facts.)
- **Deep Researcher** (both): Do **live web research** with WebSearch/WebFetch. For idea mode: real
  competitors, pricing, market size, existing free substitutes. For technical mode: prior art,
  library/approach comparisons, known pitfalls, maintenance reputation. Cite what you find.
- **The Buyer** (idea mode only): Role-play the actual target customer from the brief. Would you
  pay for this? At what price? What would make you churn? Be honest and specific as that persona.
- **Maintainer** (technical mode only): Judge the long-term cost, complexity, operability, who
  maintains this in 6 months, failure modes, migration/rollback risk. What does this cost us later?

So: **idea** = Contrarian, Expansionist, First-Principles, Deep Researcher, Buyer.
**technical** = Contrarian, Expansionist, First-Principles, Deep Researcher, Maintainer.

### 5. Judge: dispatch ONE separate Judge agent

After all five persona agents return, dispatch **one** Judge agent (`general-purpose`). Give it the
brief + all five persona reports verbatim. It must NOT be one of the personas. Instruct it to return
the verdict in the output schema below. **You (the session running /roast) do not write the verdict, relay
the Judge's output.**

### 6. Render the verdict to chat

Print the Judge's verdict to the conversation (chat only, write nothing to disk):

```
VERDICT: <GREEN-LIGHT | RESHAPE | KILL>   (confidence: <low|med|high>)

<one-line call, the crisp summary>

WHY
- Biggest risk: <…>
- Biggest upside: <…>

SCORES
| Persona | Score |
| ------- | ----- |
| Contrarian | x/10 |
| Expansionist | x/10 |
| First-Principles | x/10 |
| Deep Researcher | x/10 |
| Buyer or Maintainer | x/10 |

CHEAPEST TEST (next 48h / spike)
<one concrete, cheap action to validate before building anything>
```

Render SCORES as a real markdown table. The CHEAPEST TEST is mode-aware: a **48-hour test** for
idea mode (e.g. "DM 20 to 30 target buyers, see if they'd pay"), a **validation spike** for technical
mode (e.g. "prototype the risky integration in a throwaway branch").

## Discipline

- **Five personas, always one parallel batch.** Never dispatch them one at a time, that defeats
  the purpose and is slow.
- **The Judge is a separate agent.** The session running /roast relays; it does not grade.
- **Chat only.** `/roast` writes no files and never edits the repo.
- **No emoji** unless the user asked for them.
- **First-Principles gets no external context**; that isolation is the point; don't let it research.

## Edge cases

- **No argument**: ask the user for the one-line idea/decision, then proceed.
- **Ambiguous mode**: state your best guess in one line and proceed; the user can override.
- **A persona agent fails / returns nothing**: note it in the SCORES table (e.g. `no report`)
  and let the Judge proceed on the remaining reports rather than blocking.
- **Web research turns up nothing useful**: the Deep Researcher says so plainly; it does not
  fabricate competitors or sources.
