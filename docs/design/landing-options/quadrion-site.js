const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const menu = $('.q-menu-button');
function closeMenu() {
  menu?.setAttribute('aria-expanded', 'false');
  $('.q-header')?.classList.remove('is-open');
  $$('.q-use-cases').forEach((d) => (d.open = false));
}
menu?.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  $('.q-header').classList.toggle('is-open', open);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const active = $('.q-header')?.contains(document.activeElement);
    closeMenu();
    if (active && innerWidth <= 900) menu.focus();
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.q-header')) closeMenu();
});
$$('.q-header a').forEach((a) => a.addEventListener('click', closeMenu));
const reveal = new IntersectionObserver(
  (entries) =>
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('q-visible');
        reveal.unobserve(e.target);
      }
    }),
  { threshold: 0.08 },
);
$$('.q-feature, .q-product-story, .q-intelligence').forEach((e) => {
  e.classList.add('q-reveal');
  reveal.observe(e);
});
function click(s) {
  const el = $(s);
  if (!el || el.disabled) return false;
  el.click();
  return true;
}
function select(s, value) {
  const el = $(s);
  if (!el || el.disabled) return false;
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
function check(s, value) {
  const el = $(s);
  if (el && el.checked !== value) el.click();
}
const page = document.body.dataset.page;
const actions = {
  'confined-spaces': {
    interior: () => {
      click('[data-camera="orbit"]');
      click('[data-surface="cutaway"]');
      check('[data-layer="scan"]', true);
      select('.scan-colour', 'height');
      return [
        '.tank-workspace',
        'The shell is cut away. Height-coloured LiDAR reveals the recorded interior surfaces.',
      ];
    },
    flight: () => {
      click('[data-camera="drone"]');
      check('[data-layer="scan"]', false);
      return [
        '.tank-workspace',
        'You are at the recorded drone position. Use the flight timeline to move through the inspection.',
      ];
    },
    finding: () => {
      click('[data-inside-finding="F05"]');
      return [
        '.interior-evidence',
        'F05: the source photograph, location and recorded condition belong to the same observation.',
      ];
    },
  },
  corrosion: {
    whole: () => {
      click('[data-view="whole"]');
      return [
        '.corrosion-lab',
        'The full flare stack gives each mapped observation its height and context.',
      ];
    },
    masks: () => {
      click('[data-view="detail"]');
      if ($('.toggle-masks').getAttribute('aria-pressed') !== 'true') click('.toggle-masks');
      return [
        '.corrosion-lab',
        'Orange marks visible rust; yellow marks staining or oxidation. These are the original review classes.',
      ];
    },
    source: () => {
      click('[data-view="photo"]');
      return [
        '.corrosion-lab',
        'The camera uses the source pose. Compare the mapped patch with the original photograph alongside it.',
      ];
    },
  },
  roads: {
    corridor: () => [
      '.case-lab',
      'Move the chainage slider or select a condition bar to explore the recorded road sections.',
    ],
    defect: () => {
      select('#road-type', 'potholes');
      return [
        '.case-evidence-block',
        'The outline follows a recorded pothole in the original orthomosaic close-up.',
      ];
    },
    condition: () => {
      select('#road-assumption', 'high');
      return [
        '.case-lab',
        'High severity assumption selected. This changes the assessment scenario, not the source defects.',
      ];
    },
  },
  volumetric: {
    pile: () => {
      select('#volume-pile', 'P02');
      return [
        '.case-lab',
        'Pile 02 is selected. Its recorded toe defines the footprint being measured.',
      ];
    },
    dates: () => {
      select('#volume-date', $('#volume-date').value === 'e1' ? 'e2' : 'e1');
      return [
        '.case-lab',
        'Survey date changed. The camera stays in place so the two captured surfaces can be compared.',
      ];
    },
    base: () => {
      select('#volume-base', 'plane');
      return [
        '.case-lab',
        'Best-fit toe plane selected. Source fill, cut and net quantities update for this base method.',
      ];
    },
  },
  facades: {
    elevation: () => {
      click('[data-photo="p1736"]');
      return [
        '.case-lab',
        'East elevation, podium: the component and elevation metadata orient this original image.',
      ];
    },
    regions: () => {
      check('#facade-masks', true);
      check('#facade-boxes', true);
      return [
        '.case-lab',
        'Source class masks and finding outlines are visible. Use opacity to compare them with the photograph.',
      ];
    },
    thermal: () => {
      click('[data-photo="p2736"]');
      return [
        '.case-lab',
        'Original thermal evidence. The observation describes the source review, not a new temperature diagnosis.',
      ];
    },
  },
  evidence: {
    proof: () => {
      click('[data-finding="F05"]');
      return [
        '.evidence-workspace',
        'F05 links the original photo to its recorded location in the tank.',
      ];
    },
    review: () => [
      '.finding-description',
      'Inspect the observation, then choose “Mark reviewed” when you have finished your review.',
    ],
    deliver: () => {
      check('.include-report', true);
      return [
        '.review-summary',
        'The selected finding is included in your sample report. Continue to Reports & handover.',
      ];
    },
  },
  reporting: {
    choose: () => [
      '.report-settings',
      'Select the source findings to include. Your register and report preview update together.',
    ],
    report: () => [
      '.report-preview',
      'A readable deliverable with the original evidence retained beside each finding.',
    ],
    export: () => [
      '.q-pdf-download',
      'Download the fixed source-based sample PDF, or export the current selection as CSV.',
    ],
  },
};
$$('[data-guide]').forEach((button) =>
  button.addEventListener('click', () => {
    if (document.body.dataset.ready !== 'true' && !window.corrosionPreview?.getState().ready) {
      $('.q-guide-status').textContent =
        'The example is still loading. Please try this chapter in a moment.';
      return;
    }
    const action = actions[page]?.[button.dataset.guide];
    if (!action) return;
    const [target, caption] = action();
    $$('[data-guide]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    $('.q-guide-status').textContent = caption;
    const el = $(target) || $('.case-workspace') || $('main');
    el.scrollIntoView({ behavior: reduced.matches ? 'instant' : 'smooth', block: 'start' });
    let note = $('.q-context-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'q-context-note';
      note.setAttribute('role', 'status');
      document.body.append(note);
    }
    note.textContent = caption;
    clearTimeout(note.hideTimer);
    note.hidden = false;
    note.hideTimer = setTimeout(() => (note.hidden = true), 7000);
  }),
);
// Keep an expanded desktop menu from becoming a stale mobile navigation state.
matchMedia('(max-width: 900px)').addEventListener('change', closeMenu);
