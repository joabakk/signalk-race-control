const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ensureRaceShape, effectiveStartTime, findClass, raceSummary, emptyCourse } = require('../index.js').internal;

function bareRace(overrides) {
  return Object.assign(
    {
      id: 'r1',
      name: 'Test Race',
      boats: {}
    },
    overrides
  );
}

describe('emptyCourse', () => {
  test('has null lines and no marks', () => {
    assert.deepEqual(emptyCourse(), { startLine: null, marks: [], finishLine: null });
  });
});

describe('ensureRaceShape', () => {
  test('backfills every optional field on a bare/legacy race', () => {
    const race = bareRace();
    ensureRaceShape(race);
    assert.deepEqual(race.course, { startLine: null, marks: [], finishLine: null });
    assert.equal(race.selfBoatId, null);
    assert.equal(race.stopTime, null);
    assert.equal(race.scheduledCallOff, null);
    assert.equal(race.multiDay, false);
    assert.equal(race.courseActivated, false);
    assert.deepEqual(race.classes, []);
  });

  test('leaves already-present fields alone', () => {
    const race = bareRace({ multiDay: true, courseActivated: true, selfBoatId: 'b1' });
    ensureRaceShape(race);
    assert.equal(race.multiDay, true);
    assert.equal(race.courseActivated, true);
    assert.equal(race.selfBoatId, 'b1');
  });

  test('backfills every optional boat field', () => {
    const race = bareRace({ boats: { b1: { id: 'b1', name: 'Solli' } } });
    ensureRaceShape(race);
    const b = race.boats.b1;
    assert.deepEqual(b.track, []);
    assert.equal(b.dnf, false);
    assert.equal(b.dns, false);
    assert.equal(b.dnfPosition, null);
    assert.equal(b.startTime, null);
    assert.equal(b.sailNumber, null);
    assert.equal(b.classId, null);
    assert.deepEqual(b.markTimes, {});
  });

  test('backfills a startTime on every class', () => {
    const race = bareRace({ classes: [{ id: 'c1', name: 'Cruisers' }] });
    ensureRaceShape(race);
    assert.equal(race.classes[0].startTime, null);
  });

  test('clears a boat classId that no longer matches any class (deleted class)', () => {
    const race = bareRace({
      classes: [{ id: 'c1', name: 'Cruisers', startTime: null }],
      boats: {
        b1: { id: 'b1', name: 'Stays', classId: 'c1' },
        b2: { id: 'b2', name: 'Stale', classId: 'c-deleted' }
      }
    });
    ensureRaceShape(race);
    assert.equal(race.boats.b1.classId, 'c1');
    assert.equal(race.boats.b2.classId, null);
  });

  test('is idempotent — running it twice changes nothing further', () => {
    const race = bareRace({ boats: { b1: { id: 'b1', name: 'Solli' } } });
    ensureRaceShape(race);
    const once = JSON.stringify(race);
    ensureRaceShape(race);
    assert.equal(JSON.stringify(race), once);
  });
});

describe('findClass', () => {
  test('finds a class by id', () => {
    const race = bareRace({ classes: [{ id: 'c1', name: 'Cruisers' }, { id: 'c2', name: 'Racers' }] });
    assert.equal(findClass(race, 'c2').name, 'Racers');
  });

  test('returns null for an unknown id', () => {
    const race = bareRace({ classes: [{ id: 'c1', name: 'Cruisers' }] });
    assert.equal(findClass(race, 'nope'), null);
  });

  test('returns null when the race has no classes array at all', () => {
    assert.equal(findClass(bareRace(), 'c1'), null);
  });
});

describe('effectiveStartTime — priority chain: boat > class > race', () => {
  test("falls back to the race's own start time with no boat or class override", () => {
    const race = bareRace({ startTime: 1000, classes: [] });
    const boat = { classId: null, startTime: null };
    assert.equal(effectiveStartTime(race, boat), 1000);
  });

  test("falls back to the boat's class start time over the race's", () => {
    const race = bareRace({ startTime: 1000, classes: [{ id: 'c1', name: 'Cruisers', startTime: 2000 }] });
    const boat = { classId: 'c1', startTime: null };
    assert.equal(effectiveStartTime(race, boat), 2000);
  });

  test("a boat's own start time wins over its class's", () => {
    const race = bareRace({ startTime: 1000, classes: [{ id: 'c1', name: 'Cruisers', startTime: 2000 }] });
    const boat = { classId: 'c1', startTime: 3000 };
    assert.equal(effectiveStartTime(race, boat), 3000);
  });

  test("a boat's own start time wins even with no class at all", () => {
    const race = bareRace({ startTime: 1000, classes: [] });
    const boat = { classId: null, startTime: 3000 };
    assert.equal(effectiveStartTime(race, boat), 3000);
  });

  test('falls through to the race start when the boat is in a class with no start time of its own', () => {
    const race = bareRace({ startTime: 1000, classes: [{ id: 'c1', name: 'Cruisers', startTime: null }] });
    const boat = { classId: 'c1', startTime: null };
    assert.equal(effectiveStartTime(race, boat), 1000);
  });
});

describe('raceSummary', () => {
  test('counts boats, finished, and DNF correctly', () => {
    const race = bareRace({
      createdAt: 42,
      scheduledStart: null,
      startTime: null,
      boats: {
        b1: { finishTime: 100, dnf: false },
        b2: { finishTime: null, dnf: true },
        b3: { finishTime: null, dnf: false }
      }
    });
    const summary = raceSummary(race);
    assert.equal(summary.boatCount, 3);
    assert.equal(summary.finishedCount, 1);
    assert.equal(summary.dnfCount, 1);
    assert.equal(summary.id, 'r1');
    assert.equal(summary.name, 'Test Race');
  });

  test('handles a race with no boats', () => {
    const summary = raceSummary(bareRace());
    assert.equal(summary.boatCount, 0);
    assert.equal(summary.finishedCount, 0);
    assert.equal(summary.dnfCount, 0);
  });
});
