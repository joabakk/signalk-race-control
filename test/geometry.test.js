const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { distanceNm, midpoint, segmentsIntersect, validateCoordPoint, validateLine } = require('../index.js').internal;

describe('distanceNm', () => {
  test('is zero for the same point', () => {
    assert.equal(distanceNm({ lat: 59.7, lon: 10.5 }, { lat: 59.7, lon: 10.5 }), 0);
  });

  test('one degree of latitude is ~60nm', () => {
    const nm = distanceNm({ lat: 59, lon: 10 }, { lat: 60, lon: 10 });
    assert.ok(Math.abs(nm - 60) < 1, `expected ~60nm, got ${nm}`);
  });

  test('is symmetric', () => {
    const a = { lat: 59.72, lon: 10.54 };
    const b = { lat: 59.68, lon: 10.56 };
    assert.equal(distanceNm(a, b), distanceNm(b, a));
  });
});

describe('midpoint', () => {
  test('averages lat/lon', () => {
    const m = midpoint({ lat: 59.7, lon: 10.5 }, { lat: 59.8, lon: 10.7 });
    assert.equal(m.lat, 59.75);
    assert.equal(m.lon, 10.6);
  });
});

describe('segmentsIntersect', () => {
  // A start line running roughly east-west, matching the shape of a real
  // one in this app (pin + committee boat).
  const startLineA = { lat: 59.723876, lon: 10.543537 };
  const startLineB = { lat: 59.7257498, lon: 10.5352725 };

  test('detects a genuine crossing from one side to the other', () => {
    const before = { lat: 59.7242279, lon: 10.5392721 };
    const after = { lat: 59.7253979, lon: 10.5395375 };
    assert.equal(segmentsIntersect(before, after, startLineA, startLineB), true);
  });

  test('does not fire for a track that stays on one side', () => {
    const p1 = { lat: 59.72, lon: 10.53 };
    const p2 = { lat: 59.721, lon: 10.531 };
    assert.equal(segmentsIntersect(p1, p2, startLineA, startLineB), false);
  });

  test('does not fire for a track that passes near but short of the line', () => {
    // Heads toward the line's midpoint but stops well before reaching it.
    const near = midpoint(startLineA, startLineB);
    const short = { lat: (startLineA.lat + near.lat) / 2 - 0.01, lon: (startLineA.lon + near.lon) / 2 };
    const shorter = { lat: short.lat + 0.0001, lon: short.lon + 0.0001 };
    assert.equal(segmentsIntersect(short, shorter, startLineA, startLineB), false);
  });

  test('is symmetric in which segment is "the line" vs "the track"', () => {
    const before = { lat: 59.7242279, lon: 10.5392721 };
    const after = { lat: 59.7253979, lon: 10.5395375 };
    assert.equal(
      segmentsIntersect(before, after, startLineA, startLineB),
      segmentsIntersect(startLineA, startLineB, before, after)
    );
  });
});

describe('validateCoordPoint', () => {
  test('accepts a plain lat/lon', () => {
    assert.deepEqual(validateCoordPoint({ lat: 59.7, lon: 10.5 }), { lat: 59.7, lon: 10.5 });
  });

  test('keeps a trimmed name when present', () => {
    assert.deepEqual(validateCoordPoint({ lat: 1, lon: 2, name: '  Mark 1  ' }), { lat: 1, lon: 2, name: 'Mark 1' });
  });

  test('omits an empty/whitespace-only name rather than keeping ""', () => {
    const out = validateCoordPoint({ lat: 1, lon: 2, name: '   ' });
    assert.ok(!('name' in out));
  });

  const badPoints = [null, undefined, {}, { lat: 'x', lon: 2 }, { lat: 1, lon: NaN }, { lat: 91, lon: 0 }, { lat: -91, lon: 0 }, { lat: 0, lon: 181 }, { lat: 0, lon: -181 }];
  for (const bad of badPoints) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      assert.equal(validateCoordPoint(bad), null);
    });
  }
});

describe('validateLine', () => {
  test('null passes through as null (an explicitly cleared line)', () => {
    assert.equal(validateLine(null), null);
  });

  test('validates both ends of a proper pair', () => {
    const out = validateLine([{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]);
    assert.deepEqual(out, [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]);
  });

  test('undefined (invalid) for the wrong array length', () => {
    assert.equal(validateLine([{ lat: 1, lon: 2 }]), undefined);
    assert.equal(validateLine([{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }, { lat: 5, lon: 6 }]), undefined);
  });

  test('undefined (invalid) when either end fails validation', () => {
    assert.equal(validateLine([{ lat: 1, lon: 2 }, { lat: 'x', lon: 4 }]), undefined);
  });

  test('undefined (invalid) for a non-array', () => {
    assert.equal(validateLine('not an array'), undefined);
  });
});
