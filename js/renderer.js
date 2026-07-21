/**
 * renderer.js
 *
 * Multi-pass WebGL renderer. Each video frame is processed through a small
 * render graph so we can produce physically-plausible optical blur and
 * veiling-glare (bloom) that a single-pass shader cannot:
 *
 *   video ─▶ [scene]  (aspect-cover crop, sRGB)
 *              │
 *              ├─▶ downsample ─▶ Gaussian blur ─▶ [blur1]  (½ res)
 *              │                                    │
 *              │                                    └─▶ downsample ─▶ blur ─▶ [blur2] (¼ res)
 *              │
 *              └─▶ bright-pass ─▶ Gaussian blur ─▶ [bloom] (¼ res)
 *                                                    │
 *   [scene]+[blur1]+[blur2]+[bloom] ─▶ COMPOSITE ─▶ screen
 *
 * Colour-vision deficiency uses the Machado 2009 severity model (see
 * cvd-matrices.js); the intensity slider drives clinical severity 0–100 %.
 * Structural/optical conditions use the blur pyramid + bloom for realism, and
 * glaucoma / macular degeneration model the clinically-correct "filling-in"
 * appearance (blur + desaturation + contrast loss) rather than pure black.
 *
 * Public API:
 *   Renderer.init(canvas)
 *   Renderer.render(source, { mode, intensity, isSplit, splitX, p1, p2,
 *                             freeze, staticSource })
 *   source: HTMLVideoElement | HTMLImageElement | ImageBitmap | canvas
 *   freeze: keep showing the last uploaded frame
 *   staticSource: source never changes between frames (upload once)
 *
 * Algorithms & sources:
 *   Protan/Deutan        : Machado, Oliveira & Fernandes 2009 (linear-RGB matrix)
 *   Tritan               : Brettel, Viénot & Mollon 1997 two-plane projection
 *                          (sRGB-adapted constants from DaltonLens)
 *   Daltonization        : Fidaner et al. 2005 error redistribution
 *   Achromatopsia        : rod-weighted (scotopic) luminance + photophobia bloom
 *   Gaussian blur        : separable 9-tap (GPU Gems weights)
 *   Blur ↔ linear light  : blurred in sRGB then decoded (matches classic approach)
 */

const Renderer = (() => {

  // ── Shared vertex shader ───────────────────────────────────────────────────
  const VERT = `
    attribute vec2 a_position;
    varying   vec2 v_texCoord;
    void main() {
      v_texCoord  = (a_position + 1.0) * 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const PREC = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif
  `;

  // ── Pass 1: scene — aspect-correct "cover" crop of the camera frame ────────
  const SCENE_FRAG = PREC + `
    uniform sampler2D u_texture;
    uniform vec2      u_resolution;
    uniform float     u_videoAspect;
    varying vec2      v_texCoord;

    vec2 coverUV(vec2 uv) {
      float canvasAspect = u_resolution.x / u_resolution.y;
      vec2 scale = vec2(1.0);
      if (canvasAspect > u_videoAspect) scale.y = u_videoAspect / canvasAspect;
      else                              scale.x = canvasAspect / u_videoAspect;
      return (uv - 0.5) * scale + 0.5;
    }
    void main() {
      gl_FragColor = vec4(texture2D(u_texture, coverUV(v_texCoord)).rgb, 1.0);
    }
  `;

  // ── Copy (bilinear downsample) ─────────────────────────────────────────────
  const COPY_FRAG = PREC + `
    uniform sampler2D u_tex;
    varying vec2      v_texCoord;
    void main() { gl_FragColor = texture2D(u_tex, v_texCoord); }
  `;

  // ── Separable 9-tap Gaussian blur ──────────────────────────────────────────
  const BLUR_FRAG = PREC + `
    uniform sampler2D u_tex;
    uniform vec2      u_texel;   // 1 / source resolution
    uniform vec2      u_dir;     // (1,0) horizontal | (0,1) vertical
    uniform float     u_radius;  // spread in source texels
    varying vec2      v_texCoord;
    void main() {
      vec2 o = u_dir * u_texel * u_radius;
      vec3 c  = texture2D(u_tex, v_texCoord).rgb * 0.227027;
      c += texture2D(u_tex, v_texCoord + o) .rgb * 0.194595;
      c += texture2D(u_tex, v_texCoord - o) .rgb * 0.194595;
      c += texture2D(u_tex, v_texCoord + o*2.0).rgb * 0.121622;
      c += texture2D(u_tex, v_texCoord - o*2.0).rgb * 0.121622;
      c += texture2D(u_tex, v_texCoord + o*3.0).rgb * 0.054054;
      c += texture2D(u_tex, v_texCoord - o*3.0).rgb * 0.054054;
      c += texture2D(u_tex, v_texCoord + o*4.0).rgb * 0.016216;
      c += texture2D(u_tex, v_texCoord - o*4.0).rgb * 0.016216;
      gl_FragColor = vec4(c, 1.0);
    }
  `;

  // ── Bright-pass (isolates highlights for veiling glare / bloom) ────────────
  const BRIGHT_FRAG = PREC + `
    uniform sampler2D u_tex;
    uniform float     u_threshold;
    varying vec2      v_texCoord;
    void main() {
      vec3 c = texture2D(u_tex, v_texCoord).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      gl_FragColor = vec4(c * smoothstep(u_threshold, 1.0, l), 1.0);
    }
  `;

  // ── Composite: all condition maths ─────────────────────────────────────────
  const COMPOSITE_FRAG = PREC + `
    uniform sampler2D u_scene;
    uniform sampler2D u_blur1;
    uniform sampler2D u_blur2;
    uniform sampler2D u_bloom;
    uniform vec2      u_resolution;
    uniform float     u_mode;
    uniform float     u_intensity;
    uniform float     u_p1;
    uniform float     u_p2;
    uniform mat3      u_cvd;      // Machado 2009 matrix (identity for non-CVD)
    varying vec2      v_texCoord;

    // sRGB transfer (IEC 61966-2-1)
    vec3 srgbToLinear(vec3 c) {
      return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
    }
    vec3 linearToSrgb(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
    }

    float hash(vec2 p) { p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 19.19); return fract(p.x * p.y); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    float scotomaMask(vec2 uv, vec2 centre, float rad) {
      vec2 d = (uv - centre) * vec2(u_resolution.x / u_resolution.y, 1.0);
      return smoothstep(rad * 1.4, rad * 0.4, length(d));
    }
    vec3 desat(vec3 c, float amt) { return mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), amt); }
    vec3 contrast(vec3 c, float amt) { return (c - 0.5) * amt + 0.5; }

    // Daltonization (Fidaner et al. 2005): compute the information lost to the
    // deficiency and redistribute it into channels the viewer can still see.
    // RG variant: red-green error into green/blue (protan/deutan).
    // BY variant: blue-yellow error into red/green (tritan).
    vec3 daltonizeRG(vec3 orig, vec3 sim) {
      vec3 err = orig - sim;
      return clamp(orig + vec3(0.0,
                               0.7 * err.r + err.g,
                               0.7 * err.r + err.b), 0.0, 1.0);
    }
    vec3 daltonizeBY(vec3 orig, vec3 sim) {
      vec3 err = orig - sim;
      return clamp(orig + vec3(err.r + 0.7 * err.b,
                               err.g + 0.7 * err.b,
                               0.0), 0.0, 1.0);
    }

    // Blur-pyramid sample in linear RGB. amount: 0=sharp, 1=blur1, 2=blur2.
    vec3 defocus(vec2 uv, float amount) {
      vec3 s = srgbToLinear(texture2D(u_scene, uv).rgb);
      if (amount <= 0.0) return s;
      vec3 b1 = srgbToLinear(texture2D(u_blur1, uv).rgb);
      if (amount <= 1.0) return mix(s, b1, amount);
      vec3 b2 = srgbToLinear(texture2D(u_blur2, uv).rgb);
      return mix(b1, b2, clamp(amount - 1.0, 0.0, 1.0));
    }

    void main() {
      vec2  uv  = v_texCoord;
      vec3  lin = srgbToLinear(texture2D(u_scene, uv).rgb);
      vec3  sim = lin;
      float asp = u_resolution.x / u_resolution.y;
      vec2  ac  = (uv - 0.5) * vec2(asp, 1.0);
      float r   = length(ac);
      float blend = u_intensity;

      if (u_mode < 0.5) {
        // 0 — Normal
        sim = lin;

      } else if (u_mode < 2.5) {
        // 1-2 — Protanopia / deuteranopia (Machado 2009, applied in linear
        // RGB). Severity is already encoded in u_cvd, so no extra blend is
        // needed. u_p2 toggles daltonization (correction) instead.
        sim = u_cvd * lin;
        if (u_p2 > 0.5) sim = daltonizeRG(lin, sim);

      } else if (u_mode < 3.5) {
        // 3 — Tritanopia: Brettel, Viénot & Mollon 1997 two-plane projection
        // (sRGB-adapted constants from DaltonLens). The Machado severity fit
        // is unreliable for tritan, so severity comes from the final
        // intensity mix instead. GLSL mat3() is column-major, so the
        // row-major source matrices are applied as v*M (row vector).
        mat3 T1 = mat3( 1.01277,  0.13548, -0.14826,
                       -0.01243,  0.86812,  0.14431,
                        0.07589,  0.80500,  0.11911);
        mat3 T2 = mat3( 0.93678,  0.18979, -0.12657,
                        0.06154,  0.81526,  0.12320,
                       -0.37562,  1.12767,  0.24796);
        vec3 sepN = vec3(0.03901, -0.02788, -0.01113);
        sim = (dot(lin, sepN) >= 0.0) ? lin * T1 : lin * T2;
        if (u_p2 > 0.5) sim = daltonizeBY(lin, sim);

      } else if (u_mode < 4.5) {
        // 4 — Achromatopsia (rod monochromacy): scotopic (rod-weighted) luminance,
        // reduced acuity, and photophobia (highlights bloom and wash out).
        vec3  w    = vec3(0.15, 0.55, 0.30);        // rods peak ~507nm → green/blue
        vec3  soft = defocus(uv, 0.6);              // reduced visual acuity
        float g    = mix(dot(lin, w), dot(soft, w), 0.45);
        vec3  bloom = srgbToLinear(texture2D(u_bloom, uv).rgb);
        sim = vec3(g) + bloom * 1.3;

      } else if (u_mode < 5.5) {
        // 5 — Glaucoma: arcuate nerve-fibre scotoma + nasal step. The brain
        // "fills in" the missing field, so loss appears as blur + desaturation +
        // reduced contrast (NOT black), with a global contrast-sensitivity drop.
        float stage = u_p2;
        float arcOffset = u_p1 * 0.45;
        vec2  arcCentre = vec2(ac.x, ac.y - arcOffset);
        float arcDist   = length(arcCentre);
        float bandInner = 0.12;
        float bandOuter = mix(0.38, 0.50, stage);
        float inBand    = smoothstep(bandInner, bandInner + 0.06, arcDist) *
                          (1.0 - smoothstep(bandOuter, bandOuter + 0.08, arcDist));
        float hemiBlend = smoothstep(-0.08, 0.08, arcCentre.y * sign(u_p1 + 0.01));
        float scotoma   = inBand * hemiBlend;
        float nasalDist = length(vec2(max(0.0, -ac.x * sign(u_p1 + 0.01)) - 0.12, ac.y));
        scotoma = max(scotoma, smoothstep(0.18, 0.06, nasalDist) * 0.8);
        float peripLoss = smoothstep(0.28, 0.42, r) * stage;
        float loss = max(scotoma, peripLoss);

        vec3 lost = contrast(desat(defocus(uv, 1.3), 0.75), 0.55);
        sim = mix(lin, lost, loss);
        sim = contrast(sim, mix(1.0, 0.82, stage));   // contrast-sensitivity loss

      } else if (u_mode < 6.5) {
        // 6 — Cataracts: 0=nuclear, 1=cortical, 2=posterior subcapsular.
        // Hallmarks: haze, contrast loss, yellow/brown tint, and forward light
        // scatter → veiling glare / halos around bright sources (bloom).
        float ctype = u_p1;
        float glareAmt = u_p2;
        vec3  bloom = srgbToLinear(texture2D(u_bloom, uv).rgb);

        if (ctype < 0.5) {
          vec3 hazed = desat(contrast(defocus(uv, 0.75), 0.78), 0.25);
          vec3 amber = vec3(1.0, 0.82, 0.42);
          float centralW = 1.0 - smoothstep(0.0, 0.5, r);
          hazed *= mix(vec3(1.0), amber, 0.30 + centralW * 0.22);
          sim = hazed + bloom * (0.5 + glareAmt * 0.7);

        } else if (ctype < 1.5) {
          float ang   = noise(vec2(atan(ac.y, ac.x) * 3.0, r * 4.0));
          float spoke = ang * smoothstep(0.10, 0.40, r);
          vec3  hazed = desat(defocus(uv, 1.1), 0.2);
          sim = mix(lin, hazed, spoke * 0.9) + bloom * (0.3 + glareAmt * 0.6);

        } else {
          float centralHaze = smoothstep(0.30, 0.0, r);
          vec3  hazed = contrast(defocus(uv, 1.2), 0.7);
          sim = mix(lin, hazed, centralHaze * 0.85) + bloom * (0.8 + glareAmt * 1.0);
        }

      } else if (u_mode < 7.5) {
        // 7 — Macular degeneration: metamorphopsia (wavy distortion) + central
        // scotoma modelled as a blurred / desaturated / low-contrast patch that
        // the brain fills in (NOT a black dot).
        float nSpots = u_p1;
        float warpAmt = u_p2;
        float ws = 4.0;
        vec2 warpUV = uv + warpAmt * 0.015 *
          vec2(noise(uv * ws) - 0.5, noise(uv * ws + 7.3) - 0.5);
        warpUV = clamp(warpUV, 0.0, 1.0);
        sim = srgbToLinear(texture2D(u_scene, warpUV).rgb);

        vec3 lost = contrast(desat(defocus(warpUV, 1.6), 0.85), 0.5);
        float mask = scotomaMask(uv, vec2(0.5, 0.5), 0.12);
        if (nSpots > 1.5) mask = max(mask, scotomaMask(uv, vec2(0.56, 0.44), 0.08));
        if (nSpots > 2.5) mask = max(mask, scotomaMask(uv, vec2(0.43, 0.56), 0.07));
        sim = mix(sim, lost, mask);

      } else if (u_mode < 8.5) {
        // 8 — Retinitis pigmentosa: peripheral rods die → genuine field loss
        // (kept dark, but soft-edged) plus night blindness (low contrast).
        float stage = u_p1 / 2.0;
        float centralR  = mix(0.28, 0.06, stage);
        float ringOuter = mix(0.60, 1.50, stage);
        float inCentre   = 1.0 - smoothstep(centralR - 0.03, centralR + 0.03, r);
        float inPeriph   = smoothstep(ringOuter - 0.05, ringOuter + 0.10, r) * (1.0 - stage);
        float visible    = max(inCentre, inPeriph);
        vec3  dim = contrast(desat(lin, 0.3), 0.7) * 0.05;   // near-black residual
        sim = mix(dim, lin, visible);

      } else if (u_mode < 9.5) {
        // 9 — Myopia: uniform circle-of-confusion defocus (whole field).
        sim = defocus(uv, u_p1 * 2.0);

      } else if (u_mode < 10.5) {
        // 10 — Hyperopia: uniform defocus (approximated; a monocular camera has
        // no depth, so distance-selective focus cannot be reproduced).
        sim = defocus(uv, u_p1 * 1.7);

      } else if (u_mode < 11.5) {
        // 11 — Astigmatism: directional (single-meridian) smear + light streaks.
        float angle = u_p1;
        float sev   = u_p2;
        float blurR = mix(2.0, 16.0, sev);
        vec2  dir = normalize(vec2(cos(angle + 1.5708), sin(angle + 1.5708)));
        vec2  tx  = 1.0 / u_resolution;
        vec3  b  = srgbToLinear(texture2D(u_scene, uv).rgb) * 0.20;
        b += srgbToLinear(texture2D(u_scene, uv + dir * tx * blurR * 0.5).rgb) * 0.15;
        b += srgbToLinear(texture2D(u_scene, uv - dir * tx * blurR * 0.5).rgb) * 0.15;
        b += srgbToLinear(texture2D(u_scene, uv + dir * tx * blurR * 1.0).rgb) * 0.12;
        b += srgbToLinear(texture2D(u_scene, uv - dir * tx * blurR * 1.0).rgb) * 0.12;
        b += srgbToLinear(texture2D(u_scene, uv + dir * tx * blurR * 1.6).rgb) * 0.08;
        b += srgbToLinear(texture2D(u_scene, uv - dir * tx * blurR * 1.6).rgb) * 0.08;
        b += srgbToLinear(texture2D(u_scene, uv + dir * tx * blurR * 2.3).rgb) * 0.05;
        b += srgbToLinear(texture2D(u_scene, uv - dir * tx * blurR * 2.3).rgb) * 0.05;
        vec3 bloom = srgbToLinear(texture2D(u_bloom, uv).rgb);
        sim = b + bloom * sev * 0.5;

      } else {
        // 12 — Presbyopia: near vision blur, approximated as centre-weighted
        // defocus (periphery = distance, stays sharp).
        float centralW = 1.0 - smoothstep(0.0, 0.45, r);
        sim = defocus(uv, u_p1 * 2.0 * centralW);
      }

      vec3 blended = mix(lin, sim, blend);
      gl_FragColor = vec4(linearToSrgb(clamp(blended, 0.0, 1.0)), 1.0);
    }
  `;

  // ── CVD mode → Machado type (tritanopia uses Brettel, in-shader) ──────────
  const CVD_TYPE = { 1: 'protanopia', 2: 'deuteranopia' };
  const IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  // ── Private state ──────────────────────────────────────────────────────────
  let gl, quadBuffer, videoTex;
  let pScene, pCopy, pBlur, pBright, pComposite;
  let scene, halfA, halfB, quarterA, quarterB, bloom;
  let fbW = 0, fbH = 0;
  let texAllocated = false, texW = 0, texH = 0;
  let lastSource = null;
  let initialized = false;
  let contextLost = false;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('Shader compile error: ' + log);
    }
    return s;
  }

  function makeProgram(vsrc, fsrc, uniformNames) {
    const vs = compileShader(gl.VERTEX_SHADER, vsrc);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsrc);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + gl.getProgramInfoLog(program));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    const loc = { a_position: gl.getAttribLocation(program, 'a_position') };
    uniformNames.forEach(n => { loc[n] = gl.getUniformLocation(program, n); });
    return { program, loc };
  }

  function createFBO(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex, w, h };
  }

  function resizeTargets(w, h) {
    if (fbW === w && fbH === h) return;
    fbW = w; fbH = h;
    [scene, halfA, halfB, quarterA, quarterB, bloom].forEach(t => {
      if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    });
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    scene    = createFBO(w, h);
    halfA    = createFBO(hw, hh);
    halfB    = createFBO(hw, hh);
    quarterA = createFBO(qw, qh);
    quarterB = createFBO(qw, qh);
    bloom    = createFBO(qw, qh);
  }

  function bindQuad(program) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(program.loc.a_position);
    gl.vertexAttribPointer(program.loc.a_position, 2, gl.FLOAT, false, 0, 0);
  }

  function setTex(program, name, tex, unit) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(program.loc[name], unit);
  }

  function drawTo(target, program, setUniforms) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, target.w, target.h);
    gl.useProgram(program.program);
    bindQuad(program);
    setUniforms();
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Separable Gaussian: horizontal ping→pong, vertical pong→ping (result in ping)
  function blurInto(ping, pong, radius) {
    drawTo(pong, pBlur, () => {
      setTex(pBlur, 'u_tex', ping.tex, 0);
      gl.uniform2f(pBlur.loc.u_texel, 1 / ping.w, 1 / ping.h);
      gl.uniform2f(pBlur.loc.u_dir, 1, 0);
      gl.uniform1f(pBlur.loc.u_radius, radius);
    });
    drawTo(ping, pBlur, () => {
      setTex(pBlur, 'u_tex', pong.tex, 0);
      gl.uniform2f(pBlur.loc.u_texel, 1 / pong.w, 1 / pong.h);
      gl.uniform2f(pBlur.loc.u_dir, 0, 1);
      gl.uniform1f(pBlur.loc.u_radius, radius);
    });
  }

  // Memoized CVD matrix — recomputing/allocating per frame is pointless
  // garbage; mode and intensity only change on user input.
  let cvdCacheMode = -1, cvdCacheIntensity = -1, cvdCacheMat = IDENTITY;

  function compositeDraw(w, h, mode, intensity, p1, p2) {
    let cvd = IDENTITY;
    let blend = intensity;
    if (mode >= 1 && mode <= 2) {
      // Intensity slider drives Machado severity; the matrix carries the
      // effect. (Tritanopia, mode 3, projects in-shader via Brettel and
      // keeps blend = intensity for its severity.)
      if (cvdCacheMode !== mode || cvdCacheIntensity !== intensity) {
        cvdCacheMat = CVDMatrices.toColumnMajor(CVDMatrices.matrix(CVD_TYPE[mode], intensity));
        cvdCacheMode = mode;
        cvdCacheIntensity = intensity;
      }
      cvd = cvdCacheMat;
      blend = 1.0;
    }
    gl.useProgram(pComposite.program);
    bindQuad(pComposite);
    setTex(pComposite, 'u_scene', scene.tex, 0);
    setTex(pComposite, 'u_blur1', halfA.tex, 1);
    setTex(pComposite, 'u_blur2', quarterA.tex, 2);
    setTex(pComposite, 'u_bloom', bloom.tex, 3);
    gl.uniform2f(pComposite.loc.u_resolution, w, h);
    gl.uniform1f(pComposite.loc.u_mode, mode);
    gl.uniform1f(pComposite.loc.u_intensity, blend);
    gl.uniform1f(pComposite.loc.u_p1, p1);
    gl.uniform1f(pComposite.loc.u_p2, p2);
    gl.uniformMatrix3fv(pComposite.loc.u_cvd, false, cvd);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Create every GPU-side resource. Called at init and again after a
  // restored context (which resets the context and invalidates all objects).
  function createResources() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1
    ]), gl.STATIC_DRAW);

    videoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    pScene     = makeProgram(VERT, SCENE_FRAG,     ['u_texture', 'u_resolution', 'u_videoAspect']);
    pCopy      = makeProgram(VERT, COPY_FRAG,      ['u_tex']);
    pBlur      = makeProgram(VERT, BLUR_FRAG,      ['u_tex', 'u_texel', 'u_dir', 'u_radius']);
    pBright    = makeProgram(VERT, BRIGHT_FRAG,    ['u_tex', 'u_threshold']);
    pComposite = makeProgram(VERT, COMPOSITE_FRAG, [
      'u_scene', 'u_blur1', 'u_blur2', 'u_bloom', 'u_resolution',
      'u_mode', 'u_intensity', 'u_p1', 'u_p2', 'u_cvd'
    ]);
  }

  // ── Public: init ───────────────────────────────────────────────────────────
  function init(canvas) {
    if (initialized) return;
    gl = canvas.getContext('webgl2')
      || canvas.getContext('webgl')
      || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('no-context');

    // Mobile GPUs evict contexts under memory pressure / backgrounding.
    // preventDefault() on "lost" tells the browser we can handle a restore.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      // The context is reset: all old buffers/textures/programs are invalid.
      texAllocated = false; texW = 0; texH = 0; lastSource = null;
      fbW = 0; fbH = 0;
      scene = halfA = halfB = quarterA = quarterB = bloom = null;
      createResources();
      contextLost = false;
    });

    createResources();
    initialized = true;
  }

  function isContextLost() { return contextLost; }

  // ── Public: render ─────────────────────────────────────────────────────────
  function render(source, state) {
    if (contextLost) return;
    const w = gl.canvas.width;
    const h = gl.canvas.height;
    resizeTargets(w, h);

    // Upload the current frame (allocate on size/source change, then
    // sub-image). Static sources (photos, generated plates) upload once;
    // freeze keeps whatever frame is already on the GPU.
    const vw = source.videoWidth || source.naturalWidth || source.width || 16;
    const vh = source.videoHeight || source.naturalHeight || source.height || 9;
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    if (!texAllocated || vw !== texW || vh !== texH || source !== lastSource) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      texAllocated = true; texW = vw; texH = vh; lastSource = source;
    } else if (!state.freeze && !state.staticSource) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }

    // Pass 1 — scene (aspect-cover)
    drawTo(scene, pScene, () => {
      setTex(pScene, 'u_texture', videoTex, 0);
      gl.uniform2f(pScene.loc.u_resolution, w, h);
      gl.uniform1f(pScene.loc.u_videoAspect, vw / vh);
    });

    // The blur pyramid + bloom are only sampled by certain conditions; skip the
    // extra passes entirely for modes that don't need them (normal, CVD, RP).
    const m = state.mode;
    const needsExtra = (m === 4) || (m >= 5 && m <= 7) || (m >= 9 && m <= 12);

    if (needsExtra) {
      // Pass 2 — blur pyramid level 1 (½ res)
      drawTo(halfA, pCopy, () => setTex(pCopy, 'u_tex', scene.tex, 0));
      blurInto(halfA, halfB, 2.0);

      // Pass 3 — blur pyramid level 2 (¼ res)
      drawTo(quarterA, pCopy, () => setTex(pCopy, 'u_tex', halfA.tex, 0));
      blurInto(quarterA, quarterB, 2.0);

      // Pass 4 — bloom (bright-pass of the sharp scene, then blur), ¼ res
      drawTo(bloom, pBright, () => {
        setTex(pBright, 'u_tex', scene.tex, 0);
        gl.uniform1f(pBright.loc.u_threshold, 0.75);
      });
      blurInto(bloom, quarterB, 3.0);
    }

    // Pass 5 — composite to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    const p1 = state.p1 != null ? state.p1 : 0.0;
    const p2 = state.p2 != null ? state.p2 : 0.0;

    if (state.isSplit) {
      const sx = state.splitX != null ? state.splitX : 0.5;
      const halfx = Math.floor(w * sx);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, halfx, h);
      compositeDraw(w, h, 0, 1.0, 0, 0);                          // left = normal
      gl.scissor(halfx, 0, w - halfx, h);
      compositeDraw(w, h, state.mode, state.intensity, p1, p2);   // right = simulated
      gl.disable(gl.SCISSOR_TEST);
    } else {
      compositeDraw(w, h, state.mode, state.intensity, p1, p2);
    }
  }

  return { init, render, isContextLost };

})();
