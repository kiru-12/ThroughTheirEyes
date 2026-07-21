const { test } = require('node:test');
const assert = require('node:assert/strict');

const CVDMatrices = require('../js/cvd-matrices.js');

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

test('severity 0 is identity for both types', () => {
  assert.deepEqual(CVDMatrices.matrix('protanopia', 0), IDENTITY);
  assert.deepEqual(CVDMatrices.matrix('deuteranopia', 0), IDENTITY);
});

test('severity 1 returns the full-dichromacy table row', () => {
  assert.equal(CVDMatrices.matrix('protanopia', 1)[0], 0.152286);
  assert.equal(CVDMatrices.matrix('deuteranopia', 1)[0], 0.367322);
});

test('severity interpolates linearly between table rows', () => {
  // severity 0.05 sits halfway between row 0 (identity) and row 1
  const m = CVDMatrices.matrix('protanopia', 0.05);
  assert.ok(Math.abs(m[0] - (1 + 0.856167) / 2) < 1e-12);
  assert.ok(Math.abs(m[1] - 0.182038 / 2) < 1e-12);
});

test('severity is clamped to [0, 1]', () => {
  assert.deepEqual(CVDMatrices.matrix('protanopia', -3), IDENTITY);
  assert.deepEqual(
    CVDMatrices.matrix('protanopia', 99),
    CVDMatrices.matrix('protanopia', 1)
  );
});

test('unknown type falls back to identity', () => {
  assert.deepEqual(CVDMatrices.matrix('tritanopia', 1), IDENTITY);   // handled by Brettel in-shader
  assert.deepEqual(CVDMatrices.matrix('nonsense', 0.5), IDENTITY);
});

test('matrix(1) returns a copy, not the table row itself', () => {
  const a = CVDMatrices.matrix('protanopia', 1);
  a[0] = 999;
  assert.equal(CVDMatrices.matrix('protanopia', 1)[0], 0.152286);
});

test('toColumnMajor transposes a row-major matrix', () => {
  const rowMajor = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const cm = CVDMatrices.toColumnMajor(rowMajor);
  assert.ok(cm instanceof Float32Array);
  assert.deepEqual(Array.from(cm), [1, 4, 7, 2, 5, 8, 3, 6, 9]);
});
