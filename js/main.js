/**
 * main.js
 *
 * App entry point:
 *  - Generates the condition menu and control panels from ColorBlind.CONDITIONS
 *  - Requests camera access via getUserMedia
 *  - Drives the requestAnimationFrame render loop
 *  - Wires up all UI controls (condition picker, intensity slider,
 *    hold-to-compare button, split-screen toggle, keyboard shortcuts)
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
  const condMenu     = document.getElementById('condition-menu');
  const menuScroll   = document.getElementById('menu-scroll');
  const menuTrigger  = document.getElementById('mode-trigger');
  const menuClose    = document.getElementById('menu-close');
  const triggerIcon  = document.getElementById('trigger-icon');
  const triggerName  = document.getElementById('trigger-name');
  const slider       = document.getElementById('intensity-slider');
  const intensityVal = document.getElementById('intensity-val');
  const compareBtn   = document.getElementById('btn-compare');
  const splitBtn     = document.getElementById('btn-split');
  const splitDivider = document.getElementById('split-divider');
  const infoPanel    = document.getElementById('info-panel');
  const infoToggle   = document.getElementById('info-toggle');
  const infoTitle    = document.getElementById('info-title');
  const infoText     = document.getElementById('info-text');
  const ctrlWrap     = document.getElementById('ctrl-wrap');

  // ── App state ─────────────────────────────────────────────────────────────

  let currentMode = 0;   // integer index — see ColorBlind.MODE
  let currentModeName = 'normal';  // cached name for the active mode
  let intensity   = 1.0;
  let isSplit     = false;
  let isComparing = false;   // true while compare button is held down
  let infoPanelCollapsed = false;  // user can collapse the info panel

  // Condition-specific parameters (sent to shader as u_p1, u_p2);
  // populated with defaults while building the control panels below.
  const condParams = {};

  let animId      = null;    // requestAnimationFrame handle; null = loop not started
  let mediaStream = null;    // active MediaStream so we can stop tracks on retry

  // ── UI generation from the condition registry ────────────────────────────

  // Menu: one .menu-group per registry group, one .cond-card per condition.
  const groupEls = {};
  ColorBlind.CONDITIONS.forEach(cond => {
    let grid = groupEls[cond.group];
    if (!grid) {
      const wrap  = document.createElement('div');
      wrap.className = 'menu-group';
      const label = document.createElement('p');
      label.className = 'group-label';
      label.textContent = cond.group;
      grid = document.createElement('div');
      grid.className = 'cond-grid';
      wrap.append(label, grid);
      menuScroll.appendChild(wrap);
      groupEls[cond.group] = grid;
    }
    const card = document.createElement('button');
    card.className = 'cond-card' + (cond.name === 'normal' ? ' active' : '');
    card.dataset.mode = cond.name;
    const icon = document.createElement('span');
    icon.className = 'card-icon';
    icon.textContent = cond.icon;
    const name = document.createElement('span');
    name.className = 'card-name';
    name.textContent = cond.label;
    card.append(icon, name);
    card.addEventListener('click', () => {
      activateMode(cond.name);
      closeMenu();
    });
    grid.appendChild(card);
  });
  const condCards = document.querySelectorAll('.cond-card');

  // Control panels: one .condition-ctrl per condition that declares controls.
  const ctrlPanels = {};
  ColorBlind.CONDITIONS.forEach(cond => {
    condParams[cond.name] = { p1: 0, p2: 0 };
    if (!cond.controls.length) return;

    const panel = document.createElement('div');
    panel.className = 'condition-ctrl hidden';

    cond.controls.forEach(ctrl => {
      const row   = document.createElement('div');
      row.className = 'ctrl-row';
      const label = document.createElement('label');
      row.appendChild(label);

      if (ctrl.type === 'toggle') {
        label.textContent = ctrl.label;
        const group = document.createElement('div');
        group.className = 'ctrl-toggle-group';
        ctrl.options.forEach(opt => {
          const btn = document.createElement('button');
          btn.className = 'ctrl-btn';
          btn.textContent = opt.label;
          const isDefault = opt.value === ctrl.default;
          btn.classList.toggle('active', isDefault);
          btn.setAttribute('aria-pressed', String(isDefault));
          if (isDefault) condParams[cond.name][ctrl.param] = opt.value;
          btn.addEventListener('click', () => {
            group.querySelectorAll('.ctrl-btn').forEach(b => {
              b.classList.remove('active');
              b.setAttribute('aria-pressed', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-pressed', 'true');
            condParams[cond.name][ctrl.param] = opt.value;
          });
          group.appendChild(btn);
        });
        row.appendChild(group);

      } else { // slider
        const valSpan = document.createElement('span');
        label.textContent = ctrl.label + ' ';
        label.appendChild(valSpan);
        const input = document.createElement('input');
        input.type = 'range';
        input.min = ctrl.min;
        input.max = ctrl.max;
        input.value = ctrl.default;
        input.setAttribute('aria-label', ctrl.label);
        const apply = () => {
          const v = +input.value;
          condParams[cond.name][ctrl.param] = ctrl.toParam ? ctrl.toParam(v) : v / 100;
          valSpan.textContent = ctrl.format ? ctrl.format(v) : v + '%';
        };
        input.addEventListener('input', apply);
        apply();   // sync param + label to the default position
        row.appendChild(input);
      }

      panel.appendChild(row);
    });

    ctrlWrap.appendChild(panel);
    ctrlPanels[cond.name] = panel;
  });

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

  // ── Condition menu open / close ──────────────────────────────────────────

  // Native <dialog>: showModal() gives focus trapping and Escape-to-close.
  function openMenu()  { condMenu.showModal(); }
  function closeMenu() { condMenu.close(); }

  menuTrigger.addEventListener('click', openMenu);
  menuClose.addEventListener('click', closeMenu);
  condMenu.addEventListener('close', () => menuTrigger.focus());

  // ── Activate a mode by name ───────────────────────────────────────────────

  function activateMode(modeName) {
    const cond = ColorBlind.get(modeName) || ColorBlind.get('normal');
    currentMode = cond.index;
    currentModeName = cond.name;

    // Update trigger button display
    triggerIcon.textContent = cond.icon;
    triggerName.textContent = cond.label;

    // Mark the active card
    condCards.forEach(c => c.classList.toggle('active', c.dataset.mode === cond.name));

    // If switching to a simulation while intensity is zero, auto-restore to 100%
    if (currentMode !== 0 && intensity === 0) {
      slider.value = 100;
      intensity    = 1.0;
      intensityVal.textContent = '100%';
    }

    // Update the info panel
    if (cond.description) {
      infoTitle.textContent = cond.description.title;
      infoText.textContent  = cond.description.text;
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
      ctrlPanels[key].classList.toggle('hidden', key !== cond.name);
    });
  }

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
  function setComparing(on) {
    isComparing = on;
    compareBtn.classList.toggle('active', on);
  }
  compareBtn.addEventListener('pointerdown',   () => setComparing(true));
  compareBtn.addEventListener('pointerup',     () => setComparing(false));
  compareBtn.addEventListener('pointerleave',  () => setComparing(false));
  // pointercancel fires when the browser takes over the gesture (e.g. scroll);
  // without it the compare state would stick on.
  compareBtn.addEventListener('pointercancel', () => setComparing(false));
  // Prevent context-menu on long-press (mobile)
  compareBtn.addEventListener('contextmenu', e => e.preventDefault());

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
  const KEY_MODES = ColorBlind.CONDITIONS.filter(c => c.name !== 'normal').map(c => c.name);

  document.addEventListener('keydown', (e) => {
    if (condMenu.open) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    if (e.key === ' ') {
      if (t && t.tagName === 'BUTTON') return;   // let focused buttons activate
      e.preventDefault();                         // no page scroll
      if (!isComparing) setComparing(true);
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 's') { splitBtn.click(); return; }
    if (k === 'm') { openMenu(); return; }
    if (e.key === '0') { activateMode('normal'); return; }
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9 && n <= KEY_MODES.length) activateMode(KEY_MODES[n - 1]);
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === ' ' && isComparing) setComparing(false);
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
