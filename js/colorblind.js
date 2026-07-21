/**
 * colorblind.js
 *
 * Single source of truth for every vision condition: shader mode index, menu
 * icon/label/grouping, info-panel description, and the schema of its
 * condition-specific controls. The menu cards and control panels in the UI
 * are generated from this registry (see main.js); all simulation math lives
 * in the fragment shader in renderer.js.
 *
 * Control schema:
 *   { type:'toggle', param:'p1'|'p2', label, options:[{label,value}], default }
 *   { type:'slider', param:'p1'|'p2', label, min, max, default,
 *     format(v) -> display string,  toParam(v) -> shader value }
 *   slider defaults: format = v => v+'%', toParam = v => v/100
 */

const ColorBlind = (() => {

  // Dioptre label formatters for the refractive sliders (0-100 slider value).
  const LABELS = {
    myopia:     v => '−' + (1 + v * 0.09).toFixed(1) + 'D',
    hyperopia:  v => '+' + (1 + v * 0.04).toFixed(1) + 'D',
    presbyopia: v => '+' + (1 + v * 0.025).toFixed(1) + 'D',
    astigSev:   v => (0.5 + v * 0.035).toFixed(1) + 'D',
    degrees:    v => v + '°',
  };

  const CONDITIONS = [
    {
      name: 'normal', index: 0, icon: '👁️', label: 'Normal',
      group: 'Colour Vision', description: null, controls: [],
    },
    {
      name: 'deuteranopia', index: 2, icon: '🟢', label: 'Deuteranopia',
      group: 'Colour Vision',
      description: {
        title: 'Deuteranopia (Green-Blind)',
        text: "The most common type, affecting about 1 in 12 men. The green-sensing cells are missing. Greens and reds look alike — both appear as muddy yellows or browns."
      },
      controls: [],
    },
    {
      name: 'protanopia', index: 1, icon: '🔴', label: 'Protanopia',
      group: 'Colour Vision',
      description: {
        title: 'Protanopia (Red-Blind)',
        text: "The eye is missing its red-sensing cells. Reds look dark and dull, and it's hard to tell red from green — traffic lights and ripe fruit can look nearly identical."
      },
      controls: [],
    },
    {
      name: 'tritanopia', index: 3, icon: '🔵', label: 'Tritanopia',
      group: 'Colour Vision',
      description: {
        title: 'Tritanopia (Blue-Blind)',
        text: "Very rare — only about 1 in 10,000 people. The blue-sensing cells are missing. Blues look greenish, and yellows appear pinkish or violet."
      },
      controls: [],
    },
    {
      name: 'achromatopsia', index: 4, icon: '📷', label: 'Achromatopsia',
      group: 'Colour Vision',
      description: {
        title: 'Achromatopsia (Total Color Blindness)',
        text: "No color vision at all — the world looks like a black-and-white photograph. Usually comes with extreme sensitivity to bright light."
      },
      controls: [],
    },
    {
      name: 'glaucoma', index: 5, icon: '🌑', label: 'Glaucoma',
      group: 'Eye Diseases',
      description: {
        title: 'Glaucoma',
        text: "Fluid builds up inside the eye, pressing on the optic nerve. Side vision slowly disappears, leaving only a narrow tunnel of central vision. It often goes unnoticed until significant damage has occurred."
      },
      controls: [
        { type: 'toggle', param: 'p1', label: 'Affected Field', default: 0,
          options: [{ label: 'Superior', value: 0 }, { label: 'Inferior', value: 1 }] },
        { type: 'toggle', param: 'p2', label: 'Stage', default: 0,
          options: [{ label: 'Early', value: 0 }, { label: 'Moderate', value: 0.5 }, { label: 'Advanced', value: 1 }] },
      ],
    },
    {
      name: 'cataracts', index: 6, icon: '☁️', label: 'Cataracts',
      group: 'Eye Diseases',
      description: {
        title: 'Cataracts',
        text: "The clear lens inside the eye turns cloudy and yellow with age. Everything looks blurry, faded, and slightly yellow — like seeing through a foggy, dirty window."
      },
      controls: [
        { type: 'toggle', param: 'p1', label: 'Type', default: 0,
          options: [{ label: 'Nuclear', value: 0 }, { label: 'Cortical', value: 1 }, { label: 'Posterior', value: 2 }] },
        { type: 'slider', param: 'p2', label: 'Glare', min: 0, max: 100, default: 50 },
      ],
    },
    {
      name: 'macular', index: 7, icon: '🎯', label: 'Macular Degen.',
      group: 'Eye Diseases',
      description: {
        title: 'Macular Degeneration',
        text: "The central part of the retina — used for reading and recognising faces — breaks down. A blurry or dark patch grows in the centre of your vision while the edges stay relatively normal."
      },
      controls: [
        { type: 'toggle', param: 'p1', label: 'Scotoma spots', default: 2,
          options: [{ label: '1 (Geographic)', value: 1 }, { label: '2 (Moderate dry)', value: 2 }, { label: '3 (Early dry)', value: 3 }] },
        { type: 'slider', param: 'p2', label: 'Waviness', min: 0, max: 100, default: 50 },
      ],
    },
    {
      name: 'retinitis', index: 8, icon: '🔭', label: 'Retinitis P.',
      group: 'Eye Diseases',
      description: {
        title: 'Retinitis Pigmentosa',
        text: "A genetic condition where light-sensing cells at the edges of the retina slowly die. Side vision disappears first, then the remaining tunnel of central vision gradually shrinks over years."
      },
      controls: [
        { type: 'toggle', param: 'p1', label: 'Stage', default: 0,
          options: [{ label: 'Early', value: 0 }, { label: 'Moderate', value: 1 }, { label: 'Advanced', value: 2 }] },
      ],
    },
    {
      name: 'myopia', index: 9, icon: '🌁', label: 'Myopia',
      group: 'Refractive Errors',
      description: {
        title: 'Myopia (Short-Sightedness)',
        text: "The eye is slightly too long, so distant objects focus in front of the retina instead of on it. Close objects are clear; anything far away looks progressively blurrier. It is the most common refractive error worldwide."
      },
      controls: [
        { type: 'slider', param: 'p1', label: 'Severity', min: 0, max: 100, default: 33,
          format: LABELS.myopia },
      ],
    },
    {
      name: 'hyperopia', index: 10, icon: '📖', label: 'Hyperopia',
      group: 'Refractive Errors',
      description: {
        title: 'Hyperopia (Long-Sightedness)',
        text: "The eye is slightly too short, so the focal point falls behind the retina. Close objects — especially text — look blurry. Young eyes can compensate with extra focusing effort, but this causes eye strain and headaches."
      },
      controls: [
        { type: 'slider', param: 'p1', label: 'Severity', min: 0, max: 100, default: 33,
          format: LABELS.hyperopia },
      ],
    },
    {
      name: 'astigmatism', index: 11, icon: '✨', label: 'Astigmatism',
      group: 'Refractive Errors',
      description: {
        title: 'Astigmatism',
        text: "The cornea or lens is slightly oval rather than round, like the side of a rugby ball. This smears light in one direction, so lines at certain angles look sharp while perpendicular lines look blurry or doubled. It often occurs together with myopia or hyperopia."
      },
      controls: [
        { type: 'slider', param: 'p1', label: 'Axis', min: 0, max: 180, default: 0,
          format: LABELS.degrees, toParam: v => v * Math.PI / 180 },
        { type: 'slider', param: 'p2', label: 'Severity', min: 0, max: 100, default: 50,
          format: LABELS.astigSev },
      ],
    },
    {
      name: 'presbyopia', index: 12, icon: '👓', label: 'Presbyopia',
      group: 'Refractive Errors',
      description: {
        title: 'Presbyopia (Age-Related Near Vision Loss)',
        text: "After age 40 the lens stiffens and loses its ability to flex and focus up close. Reading, screens, and fine detail at arm's length become progressively harder to see sharply. It is universal — everyone who lives long enough will develop it."
      },
      controls: [
        { type: 'slider', param: 'p1', label: 'Age-related loss', min: 0, max: 100, default: 40,
          format: LABELS.presbyopia },
      ],
    },
  ];

  const BY_NAME = {};
  const MODE = {};
  CONDITIONS.forEach(c => { BY_NAME[c.name] = c; MODE[c.name] = c.index; });

  function get(name) {
    return BY_NAME[name] || null;
  }

  function modeIndex(name) {
    return (name in MODE) ? MODE[name] : 0;
  }

  function description(name) {
    const c = BY_NAME[name];
    return (c && c.description) || null;
  }

  return { CONDITIONS, MODE, LABELS, get, modeIndex, description };

})();

// Node (unit tests) — no-op in the browser.
if (typeof module !== 'undefined') module.exports = ColorBlind;
