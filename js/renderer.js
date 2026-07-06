/**
 * renderer.js
 *
 * WebGL renderer: uploads each video frame as a GPU texture and runs a
 * scientifically accurate CVD simulation in GLSL at 60 fps.
 *
 * Pipeline per pixel:
 *   sRGB decode → linear RGB → LMS → simulate → linear RGB → sRGB encode
 *
 * Algorithms:
 *   Protanopia / Deuteranopia : Viénot 1999  (LMS projection)
 *   Tritanopia               : Brettel 1997 (two-plane LMS projection)
 *   Achromatopsia            : BT.709 luminance
 *   LMS matrices             : Smith-Pokorny 1975, sRGB-adapted (DaltonLens)
 *
 * Public API:
 *   Renderer.init(canvas)         — initialise WebGL (call once)
 *   Renderer.render(video, state) — call every animation frame
 *
 * state = {
 *   mode:      number   integer 0–4 (see ColorBlind.MODE)
 *   intensity: number   0.0 (no effect) to 1.0 (full simulation)
 *   isSplit:   boolean  if true, left=normal / right=simulated
 * }
 */

const Renderer = (() => {

  // ── GLSL source ────────────────────────────────────────────────────────────

  const VERT_SRC = `
    attribute vec2 a_position;
    varying   vec2 v_texCoord;
    void main() {
      // Map clip-space [-1,1] → texture-space [0,1].
      // UNPACK_FLIP_Y_WEBGL is set, so no manual Y-flip needed here.
      v_texCoord  = (a_position + 1.0) * 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const FRAG_SRC = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif
    uniform sampler2D u_texture;
    uniform float     u_mode;
    uniform float     u_intensity;
    uniform vec2      u_resolution;
    uniform float     u_videoAspect;
    uniform float     u_p1;
    uniform float     u_p2;
    varying vec2      v_texCoord;

    // ── sRGB transfer functions (IEC 61966-2-1) ──────────────────────────────
    vec3 srgbToLinear(vec3 c) {
      return mix(c / 12.92,
                 pow((c + 0.055) / 1.055, vec3(2.4)),
                 step(vec3(0.04045), c));
    }
    vec3 linearToSrgb(vec3 c) {
      return mix(c * 12.92,
                 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
                 step(vec3(0.0031308), c));
    }

    // ── LMS matrices (Smith-Pokorny 1975, sRGB-adapted, DaltonLens) ──────────
    mat3 lmsFromLinearRGB() {
      return mat3(
        0.17882, 0.03456, 0.00030,
        0.43516, 0.27155, 0.00184,
        0.04119, 0.03867, 0.01467
      );
    }
    mat3 linearRGBFromLMS() {
      return mat3(
         8.09444, -1.02485, -0.03653,
       -13.05043,  5.40193, -0.41216,
        11.67206,-11.36147, 69.35132
      );
    }

    // ── Box blur on raw sRGB; r = radius in pixels ───────────────────────────
    vec3 boxBlurSRGB(vec2 uv, float r) {
      vec2 d = r / u_resolution;
      vec3 s  = texture2D(u_texture, uv + vec2(-d.x, -d.y)).rgb;
      s += texture2D(u_texture, uv + vec2( 0.0, -d.y)).rgb;
      s += texture2D(u_texture, uv + vec2( d.x, -d.y)).rgb;
      s += texture2D(u_texture, uv + vec2(-d.x,  0.0)).rgb;
      s += texture2D(u_texture, uv                   ).rgb;
      s += texture2D(u_texture, uv + vec2( d.x,  0.0)).rgb;
      s += texture2D(u_texture, uv + vec2(-d.x,  d.y)).rgb;
      s += texture2D(u_texture, uv + vec2( 0.0,  d.y)).rgb;
      s += texture2D(u_texture, uv + vec2( d.x,  d.y)).rgb;
      return s / 9.0;
    }

    // ── Golden-angle disc blur — smooth circle of confusion, no grid artefacts ──
    // 13 taps: 1 centre + 12 on a golden-angle spiral for uniform disc coverage.
    vec3 discBlurSRGB(vec2 uv, float blurR) {
      const float GA = 2.39996323;  // golden angle in radians (~137.5°)
      vec2 px = 1.0 / u_resolution;
      vec3 acc = texture2D(u_texture, uv).rgb;
      acc += texture2D(u_texture, uv + vec2(cos(GA* 1.0),sin(GA* 1.0))*sqrt( 1.0/12.0)*blurR*px).rgb;
      acc += texture2D(u_texture, uv + vec2(cos(GA* 2.0),sin(GA* 2.0))*sqrt( 2.0/12.0)*blurR*px).rgb;
      acc += texture2D(u_texture, uv + vec2(cos(GA* 3.0),sin(GA* 3.0))*sqrt( 3.0/12.0)*blurR*px).rgb;
      acc += texture2D(u_texture, uv + vec2(cos(GA* 4.0),sin(GA* 4.0))*sqrt( 4.0/12.0)*blurR*px).rgb;
      acc += texture2D(u_texture, uv + vec2(cos(GA* 5.0),sin(GA* 5.0))*sqrt( 5.0/12.0)*blurR*px).rgb;
      acc += texture2D(u_texture, uv + vec2(cos(GA* 6.0),sin(GA* 6.0))*sqrt( 6.0/12.0)*blurR*px).rgb;
      acc += texture2D(u_texture, uv + vec2(cos(GA* 7.0),sin(GA* 7.0))*sqrt( 7.0/12.0)*blurR*px).rgb;
      acc += texture2D(u_texture, uv + vec2(cos(GA* 8.0),sin(GA* 8.0))*sqrt( 8.0/12.0)*blurR*px).rgb;
      acc += texture2D(u_texture, uv + vec2(cos(GA* 9.0),sin(GA* 9.0))*sqrt( 9.0/12.0)*blurR*px).rgb;
      acc += texture2D(u_texture, uv + vec2(cos(GA*10.0),sin(GA*10.0))*sqrt(10.0/12.0)*blurR*px).rgb;
      acc += texture2D(u_texture, uv + vec2(cos(GA*11.0),sin(GA*11.0))*sqrt(11.0/12.0)*blurR*px).rgb;
      acc += texture2D(u_texture, uv + vec2(cos(GA*12.0),sin(GA*12.0))*sqrt(12.0/12.0)*blurR*px).rgb;
      return acc / 13.0;
    }

    // ── Hash / noise helpers ─────────────────────────────────────────────────
    float hash(vec2 p) {
      p = fract(p * vec2(127.1, 311.7));
      p += dot(p, p + 19.19);
      return fract(p.x * p.y);
    }

    // Smooth value noise on a grid
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    // ── Scotoma mask: soft dark/blurry blob at a given centre, radius ────────
    float scotomaMask(vec2 uv, vec2 centre, float r) {
      vec2 d = (uv - centre) * vec2(u_resolution.x / u_resolution.y, 1.0);
      return smoothstep(r * 1.4, r * 0.4, length(d));
    }

    // ── "Cover" mapping: crop the video so it fills the canvas without
    //    stretching (object-fit: cover), regardless of aspect mismatch. ──────
    vec2 coverUV(vec2 uv) {
      float canvasAspect = u_resolution.x / u_resolution.y;
      vec2 scale = vec2(1.0);
      if (canvasAspect > u_videoAspect) {
        scale.y = u_videoAspect / canvasAspect;  // crop top/bottom
      } else {
        scale.x = canvasAspect / u_videoAspect;  // crop left/right
      }
      return (uv - 0.5) * scale + 0.5;
    }

    void main() {
      // Screen coordinate (0..1 across the canvas) drives all effect geometry.
      // sampleUV is the aspect-corrected coordinate used for texture fetches.
      vec2 sampleUV = coverUV(v_texCoord);
      vec4 texel = texture2D(u_texture, sampleUV);
      vec3 lin = srgbToLinear(texel.rgb);
      vec3 sim = lin;

      // Aspect-corrected UV (for circular effects)
      float asp = u_resolution.x / u_resolution.y;
      vec2 ac = (v_texCoord - 0.5) * vec2(asp, 1.0);
      float r = length(ac);

      // ── 0: Normal ───────────────────────────────────────────────────────────
      // (sim = lin already)

      // ── 1: Protanopia (L-cone absent) — Vienot 1999 ────────────────────────
      if (u_mode > 0.5 && u_mode < 1.5) {
        vec3 lms = lmsFromLinearRGB() * lin;
        lms.r = 2.02344 * lms.g - 2.52580 * lms.b;
        sim = linearRGBFromLMS() * lms;

      // ── 2: Deuteranopia (M-cone absent) — Vienot 1999 ──────────────────────
      } else if (u_mode > 1.5 && u_mode < 2.5) {
        vec3 lms = lmsFromLinearRGB() * lin;
        lms.g = 0.49421 * lms.r + 1.24827 * lms.b;
        sim = linearRGBFromLMS() * lms;

      // ── 3: Tritanopia (S-cone absent) — Brettel 1997 ───────────────────────
      } else if (u_mode > 2.5 && u_mode < 3.5) {
        vec3 lms = lmsFromLinearRGB() * lin;
        vec3 sep = vec3(0.34478, -0.65518, 0.00000);
        if (dot(lms, sep) >= 0.0) {
          lms.b = -0.00257 * lms.r + 0.05366 * lms.g;
        } else {
          lms.b = -0.06011 * lms.r + 0.16299 * lms.g;
        }
        sim = linearRGBFromLMS() * lms;

      // ── 4: Achromatopsia — BT.709 luminance ────────────────────────────────
      } else if (u_mode > 3.5 && u_mode < 4.5) {
        float lum = dot(lin, vec3(0.2126, 0.7152, 0.0722));
        sim = vec3(lum);

      // ── 5: Glaucoma ─────────────────────────────────────────────────────────
      // Real glaucoma: arcuate scotoma following the nerve fiber layer superior
      // or inferior to fixation, plus nasal step. Only in end-stage does it
      // become a narrow central tunnel. Peripheral loss darkens to black.
      } else if (u_mode > 4.5 && u_mode < 5.5) {
        // u_p1 (-1..+1): which arcuate — negative=inferior, positive=superior
        // u_p2 (0..1): disease stage (0=early arcuate, 1=advanced tunnel)
        float stage = u_p2;

        // Convert to polar: angle from 12-o'clock, CW
        float angle = atan(ac.x, ac.y); // -PI..PI

        // Arcuate scotoma: a curved band ~30-150 degrees from fixation along
        // the horizontal raphe, offset above (u_p1>0) or below (u_p1<0)
        float arcOffset = u_p1 * 0.45;  // shift band centre up or down
        vec2  arcCentre = vec2(ac.x, ac.y - arcOffset);
        float arcDist   = length(arcCentre);

        // The scotoma is an annulus band (donut slice) between 0.15 and 0.45 
        // on the affected side, thickening with stage
        float bandInner = 0.12;
        float bandOuter = mix(0.38, 0.50, stage);
        float inBand    = smoothstep(bandInner, bandInner + 0.06, arcDist) *
                          (1.0 - smoothstep(bandOuter, bandOuter + 0.08, arcDist));

        // Restrict scotoma to one hemi-field (sign of u_p1) + spread with stage
        float hemiBlend = smoothstep(-0.08, 0.08, arcCentre.y * sign(u_p1 + 0.01));
        float scotoma   = inBand * hemiBlend;

        // Also add a nasal step (small patch near the horizontal midline nasally)
        float nasalDist = length(vec2(max(0.0, -ac.x * sign(u_p1 + 0.01)) - 0.12, ac.y));
        scotoma = max(scotoma, smoothstep(0.18, 0.06, nasalDist) * 0.8);

        // Advanced stage adds a rim of peripheral loss
        float peripLoss = smoothstep(0.28, 0.42, r) * stage;
        float darkness  = max(scotoma, peripLoss);

        sim = lin * (1.0 - darkness);

      // ── 6: Cataracts ────────────────────────────────────────────────────────
      // Types: 0=nuclear (central yellowing, reduced contrast), 
      //        1=cortical (spoke-like periphery clouding),
      //        2=posterior subcapsular (central posterior, severe glare)
      } else if (u_mode > 5.5 && u_mode < 6.5) {
        float ctype = u_p1;  // 0=nuclear, 1=cortical, 2=PSC
        float glareAmt = u_p2;

        vec3 blurred = srgbToLinear(boxBlurSRGB(sampleUV, 5.0));
        vec3 hBlurred = srgbToLinear(boxBlurSRGB(sampleUV, 12.0));

        if (ctype < 0.5) {
          // Nuclear: central yellowing/browning, worst in centre, global haze
          float centralW = 1.0 - smoothstep(0.0, 0.3, r);
          vec3 yellow = vec3(0.95, 0.78, 0.35);  // amber tint (linear)
          vec3 hazed = mix(lin * 0.70 + 0.05, hBlurred * 0.55 + 0.08, 0.45);
          sim = mix(hazed, mix(hazed, yellow, centralW * 0.55), 1.0);

        } else if (ctype < 1.5) {
          // Cortical: spoke/wedge opacities from the periphery inward
          // Simulate by mixing blur in periodic angular sectors
          float angularNoise = noise(vec2(atan(ac.y, ac.x) * 3.0, r * 4.0));
          float spokeWeight = angularNoise * smoothstep(0.10, 0.40, r);
          sim = mix(lin, hBlurred * 0.65 + 0.05, spokeWeight * 0.85);

        } else {
          // Posterior subcapsular: central haze + intense glare disk on bright areas
          float centralHaze = smoothstep(0.25, 0.0, r);
          float lum = dot(lin, vec3(0.2126, 0.7152, 0.0722));
          float glareDisk = centralHaze * smoothstep(0.5, 0.8, lum) * glareAmt;
          sim = mix(lin, hBlurred * 0.60 + 0.12, centralHaze * 0.70);
          sim = mix(sim, vec3(1.0), glareDisk * 0.65);
        }

      // ── 7: Macular Degeneration ─────────────────────────────────────────────
      // Dry AMD: multiple drusen cause patchy scotomata and metamorphopsia
      // (straight lines look wavy). Wet AMD: central bleed + leakage.
      // u_p1: 1=single central scotoma (wet AMD / geographic atrophy)
      //       2=two off-centre patches (moderate dry)
      //       3=scattered small patches (early dry)
      // u_p2: metamorphopsia strength (0=none, 1=strong waviness)
      } else if (u_mode > 6.5 && u_mode < 7.5) {
        float nSpots  = u_p1;
        float warpAmt = u_p2;

        // Metamorphopsia: warp UV by a slow-varying noise field
        float warpScale = 4.0;
        vec2 warpUV = sampleUV + warpAmt * 0.015 *
          vec2(noise(v_texCoord * warpScale       ) - 0.5,
               noise(v_texCoord * warpScale + 7.3 ) - 0.5);
        warpUV = clamp(warpUV, 0.0, 1.0);
        vec3 warped = srgbToLinear(texture2D(u_texture, warpUV).rgb);
        sim = warped;

        // Central scotoma(s): dark blurry patches
        vec3 scotomaSim = srgbToLinear(boxBlurSRGB(sampleUV, 4.0)) * 0.05;

        float mask = 0.0;
        // Spot 1: always at fixation centre
        mask = max(mask, scotomaMask(v_texCoord, vec2(0.5, 0.5), 0.12));
        if (nSpots > 1.5) {
          // Spot 2: slightly off-centre (typical of geographic atrophy spread)
          mask = max(mask, scotomaMask(v_texCoord, vec2(0.56, 0.44), 0.08));
        }
        if (nSpots > 2.5) {
          // Spot 3: second satellite atrophy zone
          mask = max(mask, scotomaMask(v_texCoord, vec2(0.43, 0.56), 0.07));
        }

        sim = mix(sim, scotomaSim, mask);

      // ── 8: Retinitis Pigmentosa ─────────────────────────────────────────────
      // RP destroys the peripheral rods first → classic ring scotoma that
      // marches inward. Night blindness (no rod function) → periphery goes
      // completely black even in dim conditions. Central island survives longest.
      // u_p1: stage 0=early (mid-periphery ring), 1=mid, 2=late (small island)
      } else if (u_mode > 7.5 && u_mode < 8.5) {
        float stage = u_p1 / 2.0;  // normalize 0..1

        // Central safe zone radius: shrinks with stage
        float centralR   = mix(0.28, 0.06, stage);
        // Ring scotoma: annulus of darkness
        float ringInner  = centralR;
        float ringOuter  = mix(0.60, 1.50, stage);

        // Inside the ring = safe (central island)
        float inCentre   = 1.0 - smoothstep(centralR - 0.03, centralR + 0.03, r);
        // Outside the ring = some very limited peripheral vision (early only)
        float inPeriphery = smoothstep(ringOuter - 0.05, ringOuter + 0.10, r)
                            * (1.0 - stage);  // disappears in late stage
        float visible    = max(inCentre, inPeriphery);

        // The lost zone goes fully black (rod photoreceptors are gone, not grey)
        sim = lin * visible;

      // ── 9: Myopia (short-sightedness) ────────────────────────────────────────
      // The eye is too long → light focuses in front of the retina. Optical
      // result: a uniform disc (circle of confusion) blur across the whole image.
      // Everything looks equally out-of-focus. No dark zones, no colour change.
      // u_p1: severity 0=mild(−1D) → 1=severe(−10D+)
      } else if (u_mode > 8.5 && u_mode < 9.5) {
        sim = srgbToLinear(discBlurSRGB(sampleUV, mix(2.0, 14.0, u_p1)));

      // ── 10: Hyperopia (long-sightedness) ──────────────────────────────────────
      // The eye is too short → light would focus behind the retina. Young eyes
      // compensate by over-flexing the lens (accommodation), causing eye strain.
      // When uncorrected or fatigued, the result is the same uniform defocus as
      // myopia — blurry at all distances, not just near.
      // u_p1: severity 0=mild(+1D) → 1=severe(+6D+)
      } else if (u_mode > 9.5 && u_mode < 10.5) {
        sim = srgbToLinear(discBlurSRGB(sampleUV, mix(1.5, 11.0, u_p1)));

      // ── 11: Astigmatism ────────────────────────────────────────────────────────
      // The cornea/lens has an oval shape → different focal lengths on different
      // meridians. The visual result is directional smearing: edges and lines
      // perpendicular to the blur axis look doubled or streaked, while parallel
      // ones stay comparatively sharp. No dark zones, no colour change.
      // u_p1: axis angle in radians (0=horizontal smear, π/2=vertical smear)
      // u_p2: severity 0=mild(0.5D) → 1=severe(4D+)
      } else if (u_mode > 10.5 && u_mode < 11.5) {
        float angle = u_p1;
        float sev   = u_p2;
        float blurR = mix(2.0, 13.0, sev);
        // Smear direction is perpendicular to the astigmatism axis
        vec2 dir  = normalize(vec2(cos(angle + 1.5708), sin(angle + 1.5708)) / u_resolution);
        // 7-tap weighted line kernel (mimics elongated circle of confusion)
        float s1 = blurR * 0.5, s2 = blurR * 1.0, s3 = blurR * 1.6;
        vec3 b  = texture2D(u_texture, sampleUV            ).rgb * 0.28;
        b      += texture2D(u_texture, sampleUV + dir * s1 ).rgb * 0.20;
        b      += texture2D(u_texture, sampleUV - dir * s1 ).rgb * 0.20;
        b      += texture2D(u_texture, sampleUV + dir * s2 ).rgb * 0.14;
        b      += texture2D(u_texture, sampleUV - dir * s2 ).rgb * 0.14;
        b      += texture2D(u_texture, sampleUV + dir * s3 ).rgb * 0.02;
        b      += texture2D(u_texture, sampleUV - dir * s3 ).rgb * 0.02;
        sim = srgbToLinear(b);

      // ── 12: Presbyopia (age-related near-vision loss) ──────────────────────────
      // The lens stiffens with age and can no longer flex to focus up close.
      // Distance vision stays sharp; near/centre objects go blurry. Simulated
      // as a blur that is strongest at the image centre (reading/near zone) and
      // fades toward the periphery (where distant objects would sit).
      // u_p1: addition severity 0=early(+1D) → 1=advanced(+3.5D)
      } else if (u_mode > 11.5) {
        // Centre-weighted blur: near zone (centre) blurry, periphery stays sharp
        float centralW = 1.0 - smoothstep(0.0, 0.40, r);
        float blurR    = mix(2.0, 12.0, u_p1) * centralW;
        sim = srgbToLinear(discBlurSRGB(sampleUV, max(blurR, 0.3)));
      }

      // ── Blend with original at the given intensity ───────────────────────────
      vec3 blended = mix(lin, sim, u_intensity);
      gl_FragColor = vec4(linearToSrgb(clamp(blended, 0.0, 1.0)), texel.a);
    }
  `;

  // ── Private state ──────────────────────────────────────────────────────────

  let gl, program, texture, posLoc, modeLoc, intensityLoc, resLoc, p1Loc, p2Loc, videoAspectLoc;
  let initialized = false;
  let texAllocated = false;   // false until the first full texImage2D upload
  let texW = 0, texH = 0;     // dimensions of the currently-allocated texture

  // ── Helpers ────────────────────────────────────────────────────────────────

  function compileShader(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compile error: ' + log);
    }
    return shader;
  }

  // ── Public: init ───────────────────────────────────────────────────────────

  function init(canvas) {
    if (initialized) return;

    gl = canvas.getContext('webgl2')
      || canvas.getContext('webgl')
      || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('no-context');

    // Flip video frames so Y=0 is at the top (matching DOM/video convention)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    // Compile & link shader program
    const vert = compileShader(gl.VERTEX_SHADER,   VERT_SRC);
    const frag = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);

    program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + gl.getProgramInfoLog(program));
    }

    // Shaders are now baked into the program; intermediate objects can be freed
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    gl.useProgram(program);

    posLoc       = gl.getAttribLocation(program,  'a_position');
    modeLoc      = gl.getUniformLocation(program, 'u_mode');
    intensityLoc = gl.getUniformLocation(program, 'u_intensity');
    resLoc       = gl.getUniformLocation(program, 'u_resolution');
    p1Loc        = gl.getUniformLocation(program, 'u_p1');
    p2Loc        = gl.getUniformLocation(program, 'u_p2');
    videoAspectLoc = gl.getUniformLocation(program, 'u_videoAspect');

    // Fullscreen quad — two counter-clockwise triangles covering NDC space
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,   1, -1,  -1,  1,
      -1,  1,   1, -1,   1,  1
    ]), gl.STATIC_DRAW);

    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Create re-usable video texture
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    initialized = true;
  }

  // ── Private: draw fullscreen quad with a given mode + intensity ───────────

  function drawQuad(mode, intensity, p1, p2) {
    gl.uniform1f(modeLoc, mode);
    gl.uniform1f(intensityLoc, intensity);
    gl.uniform1f(p1Loc, p1 != null ? p1 : 0.0);
    gl.uniform1f(p2Loc, p2 != null ? p2 : 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ── Public: render ─────────────────────────────────────────────────────────

  /**
   * @param {HTMLVideoElement} video
   * @param {{ mode: number, intensity: number, isSplit: boolean, p1?: number, p2?: number }} state
   */
  function render(video, state) {
    const w = gl.canvas.width;
    const h = gl.canvas.height;

    gl.viewport(0, 0, w, h);
    gl.uniform2f(resLoc, w, h);

    // Video's own pixel dimensions (for aspect-correct "cover" cropping)
    const vw = video.videoWidth  || 16;
    const vh = video.videoHeight || 9;
    gl.uniform1f(videoAspectLoc, vw / vh);

    // Upload the current video frame to the GPU texture (one upload per frame).
    // Allocate with texImage2D only on the first frame / when the source size
    // changes; thereafter use the cheaper texSubImage2D.
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (!texAllocated || vw !== texW || vh !== texH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      texAllocated = true;
      texW = vw;
      texH = vh;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
    }

    const p1 = state.p1 != null ? state.p1 : 0.0;
    const p2 = state.p2 != null ? state.p2 : 0.0;

    if (state.isSplit) {
      const half = Math.floor(w / 2);

      gl.enable(gl.SCISSOR_TEST);

      // Left half — normal vision (mode 0, intensity 1)
      gl.scissor(0, 0, half, h);
      drawQuad(0, 1.0, 0, 0);

      // Right half — simulated vision
      gl.scissor(half, 0, w - half, h);
      drawQuad(state.mode, state.intensity, p1, p2);

      gl.disable(gl.SCISSOR_TEST);

    } else {
      drawQuad(state.mode, state.intensity, p1, p2);
    }
  }

  return { init, render };

})();
