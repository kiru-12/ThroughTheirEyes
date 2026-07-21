const { test } = require('node:test');
const assert = require('node:assert/strict');

const ColorBlind = require('../js/colorblind.js');
const { CONDITIONS } = ColorBlind;

test('registry has 13 conditions with unique names and indices 0-12', () => {
  assert.equal(CONDITIONS.length, 13);
  const names = new Set(CONDITIONS.map(c => c.name));
  assert.equal(names.size, 13);
  const indices = CONDITIONS.map(c => c.index).sort((a, b) => a - b);
  assert.deepEqual(indices, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('every condition has icon, label, and group', () => {
  for (const c of CONDITIONS) {
    assert.ok(c.icon && typeof c.icon === 'string', `${c.name}: icon`);
    assert.ok(c.label && typeof c.label === 'string', `${c.name}: label`);
    assert.ok(c.group && typeof c.group === 'string', `${c.name}: group`);
  }
});

test('every condition except normal has a description with title and text', () => {
  for (const c of CONDITIONS) {
    if (c.name === 'normal') {
      assert.equal(c.description, null);
    } else {
      assert.ok(c.description, `${c.name}: description`);
      assert.ok(c.description.title, `${c.name}: description.title`);
      assert.ok(c.description.text, `${c.name}: description.text`);
    }
  }
});

test('control schemas are well-formed', () => {
  for (const c of CONDITIONS) {
    assert.ok(Array.isArray(c.controls), `${c.name}: controls array`);
    for (const ctrl of c.controls) {
      assert.ok(['p1', 'p2'].includes(ctrl.param), `${c.name}: param`);
      assert.ok(ctrl.label, `${c.name}: control label`);
      if (ctrl.type === 'toggle') {
        assert.ok(ctrl.options.length >= 2, `${c.name}: toggle options`);
        for (const opt of ctrl.options) {
          assert.equal(typeof opt.value, 'number', `${c.name}: option value`);
          assert.ok(opt.label, `${c.name}: option label`);
        }
        assert.ok(
          ctrl.options.some(o => o.value === ctrl.default),
          `${c.name}: toggle default is one of the option values`
        );
      } else if (ctrl.type === 'slider') {
        assert.ok(ctrl.min < ctrl.max, `${c.name}: slider range`);
        assert.ok(ctrl.default >= ctrl.min && ctrl.default <= ctrl.max,
          `${c.name}: slider default in range`);
        if (ctrl.format)  assert.equal(typeof ctrl.format, 'function');
        if (ctrl.toParam) assert.equal(typeof ctrl.toParam, 'function');
      } else {
        assert.fail(`${c.name}: unknown control type ${ctrl.type}`);
      }
    }
  }
});

test('lookup helpers', () => {
  assert.equal(ColorBlind.modeIndex('deuteranopia'), 2);
  assert.equal(ColorBlind.modeIndex('protanopia'), 1);
  assert.equal(ColorBlind.modeIndex('does-not-exist'), 0);
  assert.equal(ColorBlind.get('glaucoma').index, 5);
  assert.equal(ColorBlind.get('nope'), null);
  assert.equal(ColorBlind.description('cataracts').title, 'Cataracts');
  assert.equal(ColorBlind.description('normal'), null);
});
