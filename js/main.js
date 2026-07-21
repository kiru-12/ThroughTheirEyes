/**
 * main.js
 *
 * App entry point:
 *  - Requests camera access via getUserMedia
 *  - Drives the requestAnimationFrame render loop
 *  - Wires up all UI controls (mode buttons, intensity slider,
 *    hold-to-compare button, split-screen toggle)
 */

(async () => {

  // ── DOM refs ─────────────────────────────────────────────────────────────

  const video        = document.getElementById('camera');
  const canvas       = document.getElementById('gl-canvas');
  const loadingEl    = document.getElementById('overlay-loading');
  const errorEl      = document.getElementById('overlay-error');
  const errorTitle   = document.getElementById('error-title');
  const errorMsg     = document.getElementById('error-msg');
  const retryBtn     = document.getElementById('btn-retry');
  const condCards    = document.querySelectorAll('.cond-card');
  const condMenu     = document.getElementById('condition-menu');
  const menuTrigger  = document.getElementById('mode-trigger');
  const menuClose    = document.getElementById('menu-close');
  const triggerIcon  = document.getElementById('trigger-icon');
  const triggerName  = document.getElementById('trigger-name');

  const ICONS = {
    normal:'\ud83d\udc41\ufe0f',  // 👁️  eye
    deuteranopia:'\ud83d\udfe2',   // 🟢  green — the colour they can't see
    protanopia:'\ud83d\udd34',     // 🔴  red — the colour they can't see
    tritanopia:'\ud83d\udfe1',     // 🟡  yellow — blue-yellow confusion
    achromatopsia:'\ud83e\udda0',  // 🦠  grey/muted — no colour perception
    glaucoma:'\ud83c\udf11',       // 🌑  dark crescent — peripheral field loss
    cataracts:'\u2601\ufe0f',      // ☁️  cloud — cloudy/hazy lens
    macular:'\ud83d\udd35',        // 🔵  central disc — central scotoma
    retinitis:'\ud83d\udc41\u200d\ud83d\udde8\ufe0f', // 👁️‍🗨️  eye in speech bubble — tunnel vision
    myopia:'\ud83c\udf01',         // 🌁  foggy cityscape — blurry distance
    hyperopia:'\ud83d\udcd6',      // 📖  open book — near objects are blurry
    astigmatism:'\u2728',          // ✨  sparkle — halos and starburst distortion
    presbyopia:'\ud83d\udc53',     // 👓  reading glasses — age-related near loss
  };
  const COND_NAMES = {
    normal:'Normal', deuteranopia:'Deuteranopia', protanopia:'Protanopia',
    tritanopia:'Tritanopia', achromatopsia:'Achromatopsia', glaucoma:'Glaucoma',
    cataracts:'Cataracts', macular:'Macular Degen.', retinitis:'Retinitis P.',
    myopia:'Myopia', hyperopia:'Hyperopia', astigmatism:'Astigmatism', presbyopia:'Presbyopia'
  };
  // Menu cards take their icon from the ICONS map so the cards and the
  // trigger button always agree (single source of truth).
  condCards.forEach(c => {
    const ic = c.querySelector('.card-icon');
    if (ic && ICONS[c.dataset.mode]) ic.textContent = ICONS[c.dataset.mode];
  });

  const slider       = document.getElementById('intensity-slider');
  const intensityVal = document.getElementById('intensity-val');
  const compareBtn   = document.getElementById('btn-compare');
  const splitBtn     = document.getElementById('btn-split');
  const splitDivider = document.getElementById('split-divider');
  const infoPanel    = document.getElementById('info-panel');
  const infoToggle   = document.getElementById('info-toggle');
  const infoTitle    = document.getElementById('info-title');
  const infoText     = document.getElementById('info-text');

  // Condition-specific control panels
  const ctrlPanels = {
    glaucoma:    document.getElementById('ctrl-glaucoma'),
    cataracts:   document.getElementById('ctrl-cataracts'),
    macular:     document.getElementById('ctrl-macular'),
    retinitis:   document.getElementById('ctrl-retinitis'),
    myopia:      document.getElementById('ctrl-myopia'),
    hyperopia:   document.getElementById('ctrl-hyperopia'),
    astigmatism: document.getElementById('ctrl-astigmatism'),
    presbyopia:  document.getElementById('ctrl-presbyopia'),
  };

  // Sliders
  const glareSlider      = document.getElementById('glare-slider');
  const glareVal         = document.getElementById('glare-val');
  const warpSlider       = document.getElementById('warp-slider');
  const warpVal          = document.getElementById('warp-val');
  const myopiaSlider     = document.getElementById('myopia-slider');
  const myopiaVal        = document.getElementById('myopia-val');
  const hyperopiaSlider  = document.getElementById('hyperopia-slider');
  const hyperopiaVal     = document.getElementById('hyperopia-val');
  const astigAxisSlider  = document.getElementById('astig-axis-slider');
  const astigAxisVal     = document.getElementById('astig-axis-val');
  const astigSevSlider   = document.getElementById('astig-sev-slider');
  const astigSevVal      = document.getElementById('astig-sev-val');
  const presbyopiaSlider = document.getElementById('presbyopia-slider');
  const presbyopiaVal    = document.getElementById('presbyopia-val');

  // ── App state ─────────────────────────────────────────────────────────────

  let currentMode = 0;   // integer index — see ColorBlind.MODE
  let currentModeName = 'normal';  // cached name for the active mode
  let intensity   = 1.0;
  let isSplit     = false;
  let isComparing = false;   // true while compare button is held down
  let infoPanelCollapsed = false;  // user can collapse the info panel

  // Condition-specific parameters (sent to shader as u_p1, u_p2)
  const condParams = {
    glaucoma:    { p1: 0,    p2: 0    },  // p1=hemi(0=sup,1=inf), p2=stage(0-1)
    cataracts:   { p1: 0,    p2: 0.5  },  // p1=type(0/1/2), p2=glare
    macular:     { p1: 2,    p2: 0.5  },  // p1=spots(1-3), p2=warp
    retinitis:   { p1: 0,    p2: 0    },  // p1=stage(0/1/2)
    myopia:      { p1: 0.33, p2: 0    },  // p1=severity
    hyperopia:   { p1: 0.33, p2: 0    },  // p1=severity
    astigmatism: { p1: 0,    p2: 0.5  },  // p1=axis(rad), p2=severity
    presbyopia:  { p1: 0.4,  p2: 0    },  // p1=severity
  };

  let animId      = null;    // requestAnimationFrame handle; null = loop not started
  let mediaStream = null;    // active MediaStream so we can stop tracks on retry

  // ── Canvas sizing ─────────────────────────────────────────────────────────

  function resizeCanvas() {
    // Cap DPR at 2: high-DPI phones (3x) trebles the fragment work through the
    // blur kernels for no visible benefit on a camera feed.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w   = Math.round(window.innerWidth  * dpr);
    const h   = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
    }
  }

  // ── Current simulation mode ───────────────────────────────────────────────

  function getCurrentMode() {
    // While the compare button is held, show normal (mode 0) vision
    return isComparing ? 0 : currentMode;
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  function renderLoop() {
    animId = requestAnimationFrame(renderLoop);

    // Skip frames until the video has decoded at least one frame
    if (video.readyState < 2) return;

    // Nothing valid to draw into while the GPU context is gone; the renderer
    // rebuilds its resources on restore and we simply resume.
    if (Renderer.isContextLost()) return;

    resizeCanvas();
    // Compare-hold shows normal vision; otherwise use the active mode's params.
    const modeName = isComparing ? 'normal' : currentModeName;
    const cp = condParams[modeName] || { p1: 0, p2: 0 };
    Renderer.render(video, {
      mode: getCurrentMode(),
      intensity,
      isSplit,
      p1: cp.p1,
      p2: cp.p2
    });
  }

  // ── Error display ─────────────────────────────────────────────────────────

  function showError(title, msg) {
    loadingEl.classList.add('hidden');
    errorTitle.textContent = title;
    errorMsg.textContent   = msg;
    errorEl.classList.remove('hidden');
  }

  // ── Camera init ───────────────────────────────────────────────────────────

  async function startCamera() {
    // Reset error state and show loading indicator
    errorEl.classList.add('hidden');
    loadingEl.classList.remove('hidden');

    // Stop any previously active stream
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }

    // Check API availability (older browsers, some iOS WebViews)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError(
        'Not Supported',
        'Your browser does not support camera access. Please open this page in Chrome or Safari.'
      );
      return;
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' }, // prefer rear camera; falls back to front
          width:      { ideal: 1280 },
          height:     { ideal: 720 }
        },
        audio: false
      });

      // If the OS revokes the camera (sleep, another app claims it), surface
      // the error overlay instead of freezing on the last frame.
      const track = mediaStream.getVideoTracks()[0];
      if (track) {
        track.addEventListener('ended', () => {
          showError('Camera Stopped', 'The camera stream ended unexpectedly. Tap "Try Again" to restart it.');
        });
      }

      video.srcObject = mediaStream;
      await video.play();

      loadingEl.classList.add('hidden');

      // Initialise WebGL and start the render loop (only once)
      if (animId === null) {
        try {
          Renderer.init(canvas);
        } catch (err) {
          if (err.message === 'no-context') {
            showError(
              'WebGL Unavailable',
              'Your browser could not create a WebGL canvas. Try enabling Hardware Acceleration in your browser settings (Settings → System → Use hardware acceleration).'
            );
          } else {
            showError(
              'Graphics Error',
              'A shader failed to compile. Please open the browser console (F12) for details.\n\n' + err.message
            );
          }
          return;
        }
        renderLoop();
      }

    } catch (err) {
      switch (err.name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
          showError(
            'Permission Denied',
            'Camera access was denied. Please allow camera permission in your browser settings and tap "Try Again".'
          );
          break;
        case 'NotFoundError':
        case 'DevicesNotFoundError':
          showError('No Camera Found', 'No camera was detected on this device.');
          break;
        case 'NotReadableError':
        case 'TrackStartError':
          showError('Camera In Use', 'The camera is being used by another app. Please close it and try again.');
          break;
        default:
          showError('Camera Error', 'Could not start the camera: ' + err.message);
      }
    }
  }

  // ── UI event listeners ────────────────────────────────────────────────────

  // ── Condition menu open / close ──────────────────────────────────────────

  // Native <dialog>: showModal() gives focus trapping and Escape-to-close.
  function openMenu()  { condMenu.showModal(); }
  function closeMenu() { condMenu.close(); }

  menuTrigger.addEventListener('click', openMenu);
  menuClose.addEventListener('click', closeMenu);
  condMenu.addEventListener('close', () => menuTrigger.focus());

  // ── Activate a mode by name ───────────────────────────────────────────────

  function activateMode(modeName) {
    currentMode = ColorBlind.modeIndex(modeName);
    currentModeName = modeName;

    // Update trigger button display
    triggerIcon.textContent = ICONS[modeName] || '\ud83d\udc41\ufe0f';
    triggerName.textContent = COND_NAMES[modeName] || modeName;

    // Mark the active card
    condCards.forEach(c => c.classList.toggle('active', c.dataset.mode === modeName));

    // If switching to a simulation while intensity is zero, auto-restore to 100%
    if (currentMode !== 0 && intensity === 0) {
      slider.value = 100;
      intensity    = 1.0;
      intensityVal.textContent = '100%';
    }

    // Update the info panel
    const desc = ColorBlind.description(modeName);
    if (desc) {
      infoTitle.textContent = desc.title;
      infoText.textContent  = desc.text;
      infoPanel.classList.remove('hidden');
      if (infoPanelCollapsed) {
        infoPanelCollapsed = false;
        infoPanel.classList.remove('collapsed');
      }
    } else {
      infoPanel.classList.add('hidden');
    }

    // Show only this condition's control panel
    Object.keys(ctrlPanels).forEach(key => {
      ctrlPanels[key].classList.toggle('hidden', key !== modeName);
    });
  }

  // Condition card clicks — select mode and close menu
  condCards.forEach(card => {
    card.addEventListener('click', () => {
      activateMode(card.dataset.mode);
      closeMenu();
    });
  });

  // Info panel collapse/expand toggle
  infoToggle.addEventListener('click', () => {
    infoPanelCollapsed = !infoPanelCollapsed;
    infoPanel.classList.toggle('collapsed', infoPanelCollapsed);
  });

  // Intensity slider
  slider.addEventListener('input', () => {
    intensity = slider.value / 100;
    intensityVal.textContent = slider.value + '%';
  });

  // Hold-to-compare: while held shows normal vision for instant A/B comparison
  compareBtn.addEventListener('pointerdown', () => {
    isComparing = true;
    compareBtn.classList.add('active');
  });
  compareBtn.addEventListener('pointerup', () => {
    isComparing = false;
    compareBtn.classList.remove('active');
  });
  compareBtn.addEventListener('pointerleave', () => {
    isComparing = false;
    compareBtn.classList.remove('active');
  });
  // pointercancel fires when the browser takes over the gesture (e.g. scroll);
  // without it the compare state would stick on.
  compareBtn.addEventListener('pointercancel', () => {
    isComparing = false;
    compareBtn.classList.remove('active');
  });
  // Prevent context-menu on long-press (mobile)
  compareBtn.addEventListener('contextmenu', e => e.preventDefault());

  // Condition-specific toggle buttons (ctrl-btn)
  document.querySelectorAll('.ctrl-btn').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.classList.contains('active')));
    btn.addEventListener('click', () => {
      const ctrl = btn.dataset.ctrl;
      const val  = parseFloat(btn.dataset.val);
      // Deactivate siblings with same data-ctrl
      btn.closest('.ctrl-toggle-group').querySelectorAll('.ctrl-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      // Map ctrl name to condParams entry
      if (ctrl === 'hemi')    condParams.glaucoma.p1  = val;
      if (ctrl === 'stage')   condParams.glaucoma.p2  = val;
      if (ctrl === 'ctype')   condParams.cataracts.p1 = val;
      if (ctrl === 'spots')   condParams.macular.p1   = val;
      if (ctrl === 'rpstage') condParams.retinitis.p1 = val;
    });
  });

  // Glare slider
  glareSlider.addEventListener('input', () => {
    condParams.cataracts.p2 = glareSlider.value / 100;
    glareVal.textContent = glareSlider.value + '%';
  });

  // Warp slider
  warpSlider.addEventListener('input', () => {
    condParams.macular.p2 = warpSlider.value / 100;
    warpVal.textContent = warpSlider.value + '%';
  });

  // Helper: map 0-100 slider to dioptre label for refractive conditions
  function myopiaLabel(v)  { return '\u2212' + (1 + v * 0.09).toFixed(1) + 'D'; }
  function hyperopiaLabel(v){ return '+' + (1 + v * 0.04).toFixed(1) + 'D'; }
  function presbyopiaLabel(v){ return '+' + (1 + v * 0.025).toFixed(1) + 'D'; }
  function astigSevLabel(v) { return (0.5 + v * 0.035).toFixed(1) + 'D'; }

  myopiaSlider.addEventListener('input', () => {
    condParams.myopia.p1 = myopiaSlider.value / 100;
    myopiaVal.textContent = myopiaLabel(+myopiaSlider.value);
  });
  hyperopiaSlider.addEventListener('input', () => {
    condParams.hyperopia.p1 = hyperopiaSlider.value / 100;
    hyperopiaVal.textContent = hyperopiaLabel(+hyperopiaSlider.value);
  });
  astigAxisSlider.addEventListener('input', () => {
    condParams.astigmatism.p1 = (+astigAxisSlider.value) * Math.PI / 180;
    astigAxisVal.textContent = astigAxisSlider.value + '\u00b0';
  });
  astigSevSlider.addEventListener('input', () => {
    condParams.astigmatism.p2 = astigSevSlider.value / 100;
    astigSevVal.textContent = astigSevLabel(+astigSevSlider.value);
  });
  presbyopiaSlider.addEventListener('input', () => {
    condParams.presbyopia.p1 = presbyopiaSlider.value / 100;
    presbyopiaVal.textContent = presbyopiaLabel(+presbyopiaSlider.value);
  });

  // Sync every slider label to its initial value so the displayed dioptres
  // match the default slider positions on first paint.
  myopiaVal.textContent     = myopiaLabel(+myopiaSlider.value);
  hyperopiaVal.textContent  = hyperopiaLabel(+hyperopiaSlider.value);
  presbyopiaVal.textContent = presbyopiaLabel(+presbyopiaSlider.value);
  astigAxisVal.textContent  = astigAxisSlider.value + '\u00b0';
  astigSevVal.textContent   = astigSevLabel(+astigSevSlider.value);
  glareVal.textContent      = glareSlider.value + '%';
  warpVal.textContent       = warpSlider.value + '%';

  // Split-screen toggle
  splitBtn.addEventListener('click', () => {
    isSplit = !isSplit;
    splitBtn.classList.toggle('active', isSplit);
    splitBtn.setAttribute('aria-pressed', String(isSplit));
    splitDivider.classList.toggle('hidden', !isSplit);
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  // 0 = normal, 1-9 = conditions in menu order, Space (hold) = compare,
  // S = split, M = menu. Skipped while the dialog is open or a control that
  // uses these keys itself has focus.
  const KEY_MODES = ['deuteranopia', 'protanopia', 'tritanopia', 'achromatopsia',
                     'glaucoma', 'cataracts', 'macular', 'retinitis', 'myopia'];

  document.addEventListener('keydown', (e) => {
    if (condMenu.open) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    if (e.key === ' ') {
      if (t && t.tagName === 'BUTTON') return;   // let focused buttons activate
      e.preventDefault();                         // no page scroll
      if (!isComparing) {
        isComparing = true;
        compareBtn.classList.add('active');
      }
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 's') { splitBtn.click(); return; }
    if (k === 'm') { openMenu(); return; }
    if (e.key === '0') { activateMode('normal'); return; }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= KEY_MODES.length) activateMode(KEY_MODES[n - 1]);
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === ' ' && isComparing) {
      isComparing = false;
      compareBtn.classList.remove('active');
    }
  });

  // Retry after error
  retryBtn.addEventListener('click', startCamera);

  // Coming back from the background: mobile browsers often pause the video
  // element or kill the track entirely. Resume or restart as needed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !mediaStream) return;
    const track = mediaStream.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') {
      startCamera();
    } else if (video.paused) {
      video.play().catch(() => { /* will recover on next user interaction */ });
    }
  });

  // Keep canvas pixel dimensions in sync with the window
  window.addEventListener('resize', resizeCanvas);

  // Register the service worker for offline / installable PWA support.
  // Relative path keeps it working under a GitHub Pages project subpath.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        /* offline support is a progressive enhancement — ignore failures */
      });
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  await startCamera();

})();
