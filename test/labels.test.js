const { test } = require('node:test');
const assert = require('node:assert/strict');

const ColorBlind = require('../js/colorblind.js');
const L = ColorBlind.LABELS;

test('myopia label spans −1.0D to −10.0D', () => {
  assert.equal(L.myopia(0), '−1.0D');
  assert.equal(L.myopia(100), '−10.0D');
});

test('hyperopia label spans +1.0D to +5.0D', () => {
  assert.equal(L.hyperopia(0), '+1.0D');
  assert.equal(L.hyperopia(100), '+5.0D');
});

test('presbyopia label spans +1.0D to +3.5D', () => {
  assert.equal(L.presbyopia(0), '+1.0D');
  assert.equal(L.presbyopia(40), '+2.0D');
  assert.equal(L.presbyopia(100), '+3.5D');
});

test('astigmatism severity label spans 0.5D to 4.0D', () => {
  assert.equal(L.astigSev(0), '0.5D');
  assert.equal(L.astigSev(100), '4.0D');
});

test('degrees label', () => {
  assert.equal(L.degrees(0), '0°');
  assert.equal(L.degrees(180), '180°');
});
