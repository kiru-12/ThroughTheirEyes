/**
 * colorblind.js
 *
 * Maps mode name strings to integer constants consumed by the GLSL shader,
 * and provides human-readable descriptions for the UI info panel.
 * All simulation math lives in the fragment shader in renderer.js.
 */

const ColorBlind = (() => {

  const MODE = {
    normal:        0,
    protanopia:    1,
    deuteranopia:  2,
    tritanopia:    3,
    achromatopsia: 4,
    glaucoma:      5,
    cataracts:     6,
    macular:       7,
    retinitis:     8,
    myopia:        9,
    hyperopia:     10,
    astigmatism:   11,
    presbyopia:    12
  };

  const DESCRIPTIONS = {
    protanopia: {
      title: 'Protanopia (Red-Blind)',
      text:  "The eye is missing its red-sensing cells. Reds look dark and dull, and it's hard to tell red from green — traffic lights and ripe fruit can look nearly identical."
    },
    deuteranopia: {
      title: 'Deuteranopia (Green-Blind)',
      text:  "The most common type, affecting about 1 in 12 men. The green-sensing cells are missing. Greens and reds look alike — both appear as muddy yellows or browns."
    },
    tritanopia: {
      title: 'Tritanopia (Blue-Blind)',
      text:  "Very rare — only about 1 in 10,000 people. The blue-sensing cells are missing. Blues look greenish, and yellows appear pinkish or violet."
    },
    achromatopsia: {
      title: 'Achromatopsia (Total Color Blindness)',
      text:  "No color vision at all — the world looks like a black-and-white photograph. Usually comes with extreme sensitivity to bright light."
    },
    glaucoma: {
      title: 'Glaucoma',
      text:  "Fluid builds up inside the eye, pressing on the optic nerve. Side vision slowly disappears, leaving only a narrow tunnel of central vision. It often goes unnoticed until significant damage has occurred."
    },
    cataracts: {
      title: 'Cataracts',
      text:  "The clear lens inside the eye turns cloudy and yellow with age. Everything looks blurry, faded, and slightly yellow — like seeing through a foggy, dirty window."
    },
    macular: {
      title: 'Macular Degeneration',
      text:  "The central part of the retina — used for reading and recognising faces — breaks down. A blurry or dark patch grows in the centre of your vision while the edges stay relatively normal."
    },
    retinitis: {
      title: 'Retinitis Pigmentosa',
      text:  "A genetic condition where light-sensing cells at the edges of the retina slowly die. Side vision disappears first, then the remaining tunnel of central vision gradually shrinks over years."
    },
    myopia: {
      title: 'Myopia (Short-Sightedness)',
      text:  "The eye is slightly too long, so distant objects focus in front of the retina instead of on it. Close objects are clear; anything far away looks progressively blurrier. It is the most common refractive error worldwide."
    },
    hyperopia: {
      title: 'Hyperopia (Long-Sightedness)',
      text:  "The eye is slightly too short, so the focal point falls behind the retina. Close objects — especially text — look blurry. Young eyes can compensate with extra focusing effort, but this causes eye strain and headaches."
    },
    astigmatism: {
      title: 'Astigmatism',
      text:  "The cornea or lens is slightly oval rather than round, like the side of a rugby ball. This smears light in one direction, so lines at certain angles look sharp while perpendicular lines look blurry or doubled. It often occurs together with myopia or hyperopia."
    },
    presbyopia: {
      title: 'Presbyopia (Age-Related Near Vision Loss)',
      text:  "After age 40 the lens stiffens and loses its ability to flex and focus up close. Reading, screens, and fine detail at arm's length become progressively harder to see sharply. It is universal — everyone who lives long enough will develop it."
    }
  };

  function modeIndex(name) {
    return (name in MODE) ? MODE[name] : 0;
  }

  function description(name) {
    return DESCRIPTIONS[name] || null;
  }

  const modes = Object.keys(MODE);

  return { MODE, modeIndex, description, modes };

})();
