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
  const modeBtns     = document.querySelectorAll('.mode-btn');
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
    const dpr = window.devicePixelRatio || 1;
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

    resizeCanvas();
    const modeName = Object.keys(ColorBlind.MODE).find(k => ColorBlind.MODE[k] === getCurrentMode()) || 'normal';
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

  // Mode buttons
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      modeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = ColorBlind.modeIndex(btn.dataset.mode);

      // If the user switches to a simulation mode while intensity is at zero,
      // auto-restore it to 100 % so they see an immediate effect.
      if (currentMode !== 0 && intensity === 0) {
        slider.value = 100;
        intensity    = 1.0;
        intensityVal.textContent = '100%';
      }

      // Update the info panel
      const desc = ColorBlind.description(btn.dataset.mode);
      if (desc) {
        infoTitle.textContent = desc.title;
        infoText.textContent  = desc.text;
        infoPanel.classList.remove('hidden');
        // Re-open collapsed panel when switching to a new condition
        if (infoPanelCollapsed) {
          infoPanelCollapsed = false;
          infoPanel.classList.remove('collapsed');
        }
      } else {
        // "Normal" — hide the info panel
        infoPanel.classList.add('hidden');
      }

      // Show/hide condition-specific control panels
      Object.keys(ctrlPanels).forEach(key => {
        ctrlPanels[key].classList.toggle('hidden', key !== btn.dataset.mode);
      });
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
  // Prevent context-menu on long-press (mobile)
  compareBtn.addEventListener('contextmenu', e => e.preventDefault());

  // Condition-specific toggle buttons (ctrl-btn)
  document.querySelectorAll('.ctrl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ctrl = btn.dataset.ctrl;
      const val  = parseFloat(btn.dataset.val);
      // Deactivate siblings with same data-ctrl
      btn.closest('.ctrl-toggle-group').querySelectorAll('.ctrl-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
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

  // Split-screen toggle
  splitBtn.addEventListener('click', () => {
    isSplit = !isSplit;
    splitBtn.classList.toggle('active', isSplit);
    splitDivider.classList.toggle('hidden', !isSplit);
  });

  // Retry after error
  retryBtn.addEventListener('click', startCamera);

  // Keep canvas pixel dimensions in sync with the window
  window.addEventListener('resize', resizeCanvas);

  // ── Boot ──────────────────────────────────────────────────────────────────

  await startCamera();

})();
