/**
 * main.js
 *
 * App entry point:
 *  - Generates the condition menu and control panels from ColorBlind.CONDITIONS
 *  - Requests camera access via getUserMedia (with photo / sample-image modes
 *    as camera-less fallbacks)
 *  - Drives the requestAnimationFrame render loop with an adaptive DPR cap
 *  - Wires up all UI controls (condition picker, intensity slider,
 *    hold-to-compare, split-screen with draggable divider, freeze-frame,
 *    snapshot share, torch/zoom, keyboard shortcuts)
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
  const samplesBtn   = document.getElementById('btn-samples');
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
  const splitHandle  = document.getElementById('split-handle');
  const freezeBtn    = document.getElementById('btn-freeze');
  const shareBtn     = document.getElementById('btn-share');
  const photoBtn     = document.getElementById('btn-photo');
  const cameraBtn    = document.getElementById('btn-camera');
  const torchBtn     = document.getElementById('btn-torch');
  const photoInput   = document.getElementById('photo-input');
  const zoomRow      = document.getElementById('zoom-row');
  const zoomSlider   = document.getElementById('zoom-slider');
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
  let splitX      = 0.5;     // divider position, fraction of width
  let isComparing = false;   // true while compare button is held down
  let isFrozen    = false;   // freeze-frame: stop uploading new frames
  let infoPanelCollapsed = false;  // user can collapse the info panel

  // Frame source: live camera <video>, an uploaded photo, or a sample plate.
  let currentSource = video;
  let sourceIsVideo = true;
  let sampleMode    = false;   // tapping the canvas cycles sample plates
  let sampleIdx     = 0;

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
        label.textContent = ctrl.label + ' ';
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

  // ── Canvas sizing (with adaptive DPR cap) ─────────────────────────────────

  // Start capped at 2 (3x DPR is wasted work on a camera feed); the perf
  // guard below lowers the cap further if the device can't hold ~40 fps.
  let dprCap = 2;

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
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

  function renderState() {
    const modeName = isComparing ? 'normal' : currentModeName;
    const cp = condParams[modeName] || { p1: 0, p2: 0 };
    return {
      mode: getCurrentMode(),
      intensity,
      isSplit,
      splitX,
      p1: cp.p1,
      p2: cp.p2,
      freeze: isFrozen,
      staticSource: !sourceIsVideo
    };
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  // Rolling frame-time average; if the device can't keep up, permanently
  // lower the DPR cap for this session (2 → 1.5 → 1, never back up).
  let perfLastT = 0, perfAccum = 0, perfCount = 0;

  function renderLoop(t) {
    animId = requestAnimationFrame(renderLoop);

    // Skip frames until the video has decoded at least one frame
    if (sourceIsVideo && video.readyState < 2) return;

    // Nothing valid to draw into while the GPU context is gone; the renderer
    // rebuilds its resources on restore and we simply resume.
    if (Renderer.isContextLost()) return;

    if (perfLastT && t) {
      const dt = t - perfLastT;
      if (dt < 250) {              // ignore tab-hidden gaps
        perfAccum += dt;
        perfCount++;
        if (perfCount >= 60) {
          if (perfAccum / perfCount > 24 && dprCap > 1) {
            dprCap = dprCap > 1.5 ? 1.5 : 1;
          }
          perfAccum = 0;
          perfCount = 0;
        }
      }
    }
    perfLastT = t;

    resizeCanvas();
    Renderer.render(currentSource, renderState());
  }

  // ── Error display ─────────────────────────────────────────────────────────

  function showError(title, msg) {
    loadingEl.classList.add('hidden');
    errorTitle.textContent = title;
    errorMsg.textContent   = msg;
    errorEl.classList.remove('hidden');
  }

  // ── Frame sources: camera / photo / sample plates ─────────────────────────

  function stopCameraStream() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    torchBtn.classList.add('hidden');
    zoomRow.classList.add('hidden');
  }

  function setFrozen(on) {
    isFrozen = on;
    freezeBtn.classList.toggle('active', on);
    freezeBtn.setAttribute('aria-pressed', String(on));
    freezeBtn.textContent = on ? '▶' : '⏸';
  }

  // Make sure the renderer + loop exist (photo mode can be entered before
  // the camera ever started, e.g. when permission was denied).
  function ensureRendering() {
    if (animId !== null) return true;
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
      return false;
    }
    renderLoop();
    return true;
  }

  // Switch to a static source (photo or sample plate).
  function useStaticSource(src, isSample) {
    if (!ensureRendering()) return;
    stopCameraStream();
    currentSource = src;
    sourceIsVideo = false;
    sampleMode    = isSample;
    setFrozen(false);
    loadingEl.classList.add('hidden');
    errorEl.classList.add('hidden');
    photoBtn.classList.toggle('active', !isSample);
    cameraBtn.classList.remove('hidden');
  }

  // ── Sample plates (procedurally generated pseudo-Ishihara) ────────────────
  // Drawn locally so no copyrighted Ishihara artwork is bundled. A digit mask
  // decides which of two confusion palettes each dot samples from.

  const PLATE_SPECS = [
    { digit: '8', fig: ['#7a9958', '#8aa864', '#9cb877', '#6b8a4e'],        // red-green
      bg: ['#c98551', '#d99e63', '#e0b077', '#c7784a', '#d68e58'] },
    { digit: '3', fig: ['#c96f6f', '#d88484', '#b95e5e', '#e09a9a'],        // red-green
      bg: ['#8a9a5b', '#9dab6e', '#7d8d50', '#aab97e', '#93a364'] },
    { digit: '7', fig: ['#5b8a9a', '#6e9dab', '#4f7d8d', '#7eaab9'],        // blue-yellow
      bg: ['#c9b551', '#d9c463', '#e0cd77', '#c7ab4a', '#d6bd58'] },
  ];

  function makeSamplePlate(spec) {
    const size = 1024;
    const plate = document.createElement('canvas');
    plate.width = plate.height = size;
    const ctx = plate.getContext('2d');
    ctx.fillStyle = '#efe8da';
    ctx.fillRect(0, 0, size, size);

    // Digit mask: white-on-black glyph, sampled per dot below.
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = maskCanvas.height = size;
    const mctx = maskCanvas.getContext('2d');
    mctx.fillStyle = '#000';
    mctx.fillRect(0, 0, size, size);
    mctx.fillStyle = '#fff';
    mctx.font = 'bold 680px -apple-system, "Segoe UI", Roboto, sans-serif';
    mctx.textAlign = 'center';
    mctx.textBaseline = 'middle';
    mctx.fillText(spec.digit, size / 2, size / 2 + 30);
    const mask = mctx.getImageData(0, 0, size, size).data;

    const cx = size / 2, cy = size / 2, plateR = size * 0.47;
    for (let i = 0; i < 3200; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * plateR;
      const x = cx + Math.cos(a) * d;
      const y = cy + Math.sin(a) * d;
      const r = 4 + Math.random() * 11;
      const inFigure = mask[((y | 0) * size + (x | 0)) * 4] > 128;
      const pal = inFigure ? spec.fig : spec.bg;
      ctx.fillStyle = pal[(Math.random() * pal.length) | 0];
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    return plate;
  }

  let samplePlates = null;
  function showSamplePlate(idx) {
    if (!samplePlates) samplePlates = PLATE_SPECS.map(makeSamplePlate);
    sampleIdx = ((idx % samplePlates.length) + samplePlates.length) % samplePlates.length;
    useStaticSource(samplePlates[sampleIdx], true);
  }

  // Tap the view to cycle plates while in sample mode.
  canvas.addEventListener('click', () => {
    if (sampleMode) showSamplePlate(sampleIdx + 1);
  });

  samplesBtn.addEventListener('click', () => showSamplePlate(0));

  // ── Photo mode ────────────────────────────────────────────────────────────

  async function fileToSource(file) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(file); } catch (e) { /* fall through */ }
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  photoBtn.addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files && photoInput.files[0];
    photoInput.value = '';
    if (!file) return;
    try {
      useStaticSource(await fileToSource(file), false);
    } catch (e) {
      showError('Image Error', 'That image could not be loaded. Please try a different file.');
    }
  });

  cameraBtn.addEventListener('click', startCamera);

  // ── Camera hardware controls (torch / zoom, where supported) ──────────────

  function setupCameraControls(track) {
    torchBtn.classList.add('hidden');
    zoomRow.classList.add('hidden');
    if (!track || !track.getCapabilities) return;
    const caps = track.getCapabilities();

    if (caps.torch) {
      let torchOn = false;
      torchBtn.classList.remove('hidden');
      torchBtn.setAttribute('aria-pressed', 'false');
      torchBtn.classList.remove('active');
      torchBtn.onclick = () => {
        torchOn = !torchOn;
        track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {});
        torchBtn.classList.toggle('active', torchOn);
        torchBtn.setAttribute('aria-pressed', String(torchOn));
      };
    }

    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      zoomRow.classList.remove('hidden');
      zoomSlider.min  = caps.zoom.min;
      zoomSlider.max  = caps.zoom.max;
      zoomSlider.step = caps.zoom.step || 0.1;
      zoomSlider.value = (track.getSettings && track.getSettings().zoom) || caps.zoom.min;
      zoomSlider.oninput = () => {
        track.applyConstraints({ advanced: [{ zoom: +zoomSlider.value }] }).catch(() => {});
      };
    }
  }

  // ── Camera init ───────────────────────────────────────────────────────────

  async function startCamera() {
    // Reset error state and show loading indicator
    errorEl.classList.add('hidden');
    loadingEl.classList.remove('hidden');

    // Stop any previously active stream
    stopCameraStream();

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

      // Back on the live camera source
      currentSource = video;
      sourceIsVideo = true;
      sampleMode    = false;
      setFrozen(false);
      photoBtn.classList.remove('active');
      cameraBtn.classList.add('hidden');
      setupCameraControls(track);

      if (!ensureRendering()) return;

    } catch (err) {
      switch (err.name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
          showError(
            'Permission Denied',
            'Camera access was denied. Please allow camera permission in your browser settings and tap "Try Again" — or continue without a camera using sample images.'
          );
          break;
        case 'NotFoundError':
        case 'DevicesNotFoundError':
          showError('No Camera Found', 'No camera was detected on this device. You can still explore the simulations with sample images.');
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

  // Draggable split divider
  function positionSplitHandle() {
    splitHandle.style.left = (splitX * 100) + '%';
  }
  splitHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitHandle.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      splitX = Math.min(0.85, Math.max(0.15, ev.clientX / window.innerWidth));
      positionSplitHandle();
    };
    const onUp = () => {
      splitHandle.removeEventListener('pointermove', onMove);
      splitHandle.removeEventListener('pointerup', onUp);
      splitHandle.removeEventListener('pointercancel', onUp);
    };
    splitHandle.addEventListener('pointermove', onMove);
    splitHandle.addEventListener('pointerup', onUp);
    splitHandle.addEventListener('pointercancel', onUp);
  });

  // Freeze-frame: stop uploading new camera frames; controls stay live.
  freezeBtn.addEventListener('click', () => setFrozen(!isFrozen));

  // Snapshot: render synchronously, then read the drawing buffer before
  // returning to the event loop (so no preserveDrawingBuffer is needed).
  shareBtn.addEventListener('click', () => {
    if (animId === null || Renderer.isContextLost()) return;
    resizeCanvas();
    Renderer.render(currentSource, renderState());
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], `through-their-eyes-${currentModeName}.png`, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'ThroughTheirEyes' });
          return;
        } catch (e) {
          if (e.name === 'AbortError') return;   // user cancelled the share sheet
          /* fall through to download */
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  // 0 = normal, 1-9 = conditions in menu order, Space (hold) = compare,
  // S = split, F = freeze, M = menu. Skipped while the dialog is open or a
  // control that uses these keys itself has focus.
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
    if (k === 'f') { freezeBtn.click(); return; }
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
    if (document.visibilityState !== 'visible' || !sourceIsVideo || !mediaStream) return;
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

  positionSplitHandle();
  await startCamera();

})();
