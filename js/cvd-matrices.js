/**
 * cvd-matrices.js
 *
 * Machado, Oliveira & Fernandes (2009) — "A Physiologically-based Model for
 * Simulation of Color Vision Deficiency" (IEEE TVCG 15(6):1291-1298).
 *
 * These are the authors' pre-computed RGB→RGB simulation matrices for
 * protanomaly and deuteranomaly at severities 0.0–1.0 (step 0.1), where
 * 1.0 == full dichromacy and 0.0 == normal vision. Unlike the older
 * Viénot/Brettel dichromacy-only models, this reproduces the whole spectrum of
 * *anomalous trichromacy* (which is the common real-world case) by modelling a
 * shift in the cone photopigment peak wavelength.
 *
 * Tritanopia is NOT handled here: the Machado severity fit is unreliable for
 * tritan, so the shader uses the Brettel 1997 two-plane projection instead
 * (see renderer.js).
 *
 * Source table: https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/
 * The matrices are applied to LINEAR RGB (inside the sRGB↔linear sandwich),
 * consistent with the rest of the pipeline.
 *
 * Storage: each entry is a 9-element ROW-MAJOR array [r0c0,r0c1,r0c2, r1..].
 */

const CVDMatrices = (() => {

  const protan = [
    [1,0,0, 0,1,0, 0,0,1],
    [0.856167,0.182038,-0.038205, 0.029342,0.955115,0.015544, -0.002880,-0.001563,1.004443],
    [0.734766,0.334872,-0.069637, 0.051840,0.919198,0.028963, -0.004928,-0.004209,1.009137],
    [0.630323,0.465641,-0.095964, 0.069181,0.890046,0.040773, -0.006308,-0.007724,1.014032],
    [0.539009,0.579343,-0.118352, 0.082546,0.866121,0.051332, -0.007136,-0.011959,1.019095],
    [0.458064,0.679578,-0.137642, 0.092785,0.846313,0.060902, -0.007494,-0.016807,1.024301],
    [0.385450,0.769005,-0.154455, 0.100526,0.829802,0.069673, -0.007442,-0.022190,1.029632],
    [0.319627,0.849633,-0.169261, 0.106241,0.815969,0.077790, -0.007025,-0.028051,1.035076],
    [0.259411,0.923008,-0.182420, 0.110296,0.804340,0.085364, -0.006276,-0.034346,1.040622],
    [0.203876,0.990338,-0.194214, 0.112975,0.794542,0.092483, -0.005222,-0.041043,1.046265],
    [0.152286,1.052583,-0.204868, 0.114503,0.786281,0.099216, -0.003882,-0.048116,1.051998],
  ];

  const deutan = [
    [1,0,0, 0,1,0, 0,0,1],
    [0.866435,0.177704,-0.044139, 0.049567,0.939063,0.011370, -0.003453,0.007233,0.996220],
    [0.760729,0.319078,-0.079807, 0.090568,0.889315,0.020117, -0.006027,0.013325,0.992702],
    [0.675425,0.433850,-0.109275, 0.125303,0.847755,0.026942, -0.007950,0.018572,0.989378],
    [0.605511,0.528560,-0.134071, 0.155318,0.812366,0.032316, -0.009376,0.023176,0.986200],
    [0.547494,0.607765,-0.155259, 0.181692,0.781742,0.036566, -0.010410,0.027275,0.983136],
    [0.498864,0.674741,-0.173604, 0.205199,0.754872,0.039929, -0.011131,0.030969,0.980162],
    [0.457771,0.731899,-0.189670, 0.226409,0.731012,0.042579, -0.011595,0.034333,0.977261],
    [0.422823,0.781057,-0.203881, 0.245752,0.709602,0.044646, -0.011843,0.037423,0.974421],
    [0.392952,0.823610,-0.216562, 0.263559,0.690210,0.046232, -0.011910,0.040281,0.971630],
    [0.367322,0.860646,-0.227968, 0.280085,0.672501,0.047413, -0.011820,0.042940,0.968881],
  ];

  const TABLES = { protanopia: protan, deuteranopia: deutan };

  /**
   * Interpolated row-major 3x3 matrix for a CVD type at a given severity.
   * @param {'protanopia'|'deuteranopia'} type
   * @param {number} severity 0.0–1.0
   * @returns {number[]} 9-element row-major matrix
   */
  function matrix(type, severity) {
    const table = TABLES[type];
    if (!table) return [1,0,0, 0,1,0, 0,0,1];

    const s = Math.max(0, Math.min(1, severity)) * 10; // 0–10 index space
    const i = Math.floor(s);
    if (i >= 10) return table[10].slice();
    const t = s - i;
    const a = table[i];
    const b = table[i + 1];
    const out = new Array(9);
    for (let k = 0; k < 9; k++) out[k] = a[k] + (b[k] - a[k]) * t;
    return out;
  }

  /**
   * Row-major 3x3 → column-major Float32Array (for WebGL1 uniformMatrix3fv,
   * which does not permit transpose=true).
   */
  function toColumnMajor(m) {
    return new Float32Array([
      m[0], m[3], m[6],
      m[1], m[4], m[7],
      m[2], m[5], m[8],
    ]);
  }

  return { matrix, toColumnMajor };

})();

// Node (unit tests) — no-op in the browser.
if (typeof module !== 'undefined') module.exports = CVDMatrices;
