const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginFactory = require('../index.js');

// ---- Minimal SignalK app + Express-router mocks --------------------------
// Just enough surface for the plugin to run its full HTTP-facing behavior
// without a real SignalK server: a scratch data directory for race-state.json,
// and no-op stubs for everything optional (resourcesApi, activateRoute,
// getSelfPath/getPath) so those best-effort code paths cleanly no-op, the
// same as they do on a real server with no resources provider configured.

function makeApp(dataDir) {
  return {
    getDataDirPath: () => dataDir,
    setPluginStatus: () => {},
    debug: () => {},
    error: () => {}
    // getSelfPath / getPath / resourcesApi / activateRoute deliberately
    // absent — every call site already guards for that.
  };
}

function makeRouter() {
  const routes = [];
  const register = (method) => (routePath, handler) => {
    const keys = [];
    const patternSrc = routePath.replace(/:[A-Za-z]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    });
    routes.push({ method, pattern: new RegExp(`^${patternSrc}$`), keys, handler });
  };
  return {
    get: register('GET'),
    post: register('POST'),
    put: register('PUT'),
    delete: register('DELETE'),
    _routes: routes
  };
}

// Invokes a registered route handler as Express would, minus anything this
// plugin's handlers never rely on (headers, streaming, middleware order).
function call(router, method, routePath, { body, query } = {}) {
  const [pathname, qs] = routePath.split('?');
  const route = router._routes.find((r) => r.method === method && r.pattern.test(pathname));
  if (!route) throw new Error(`No route registered for ${method} ${routePath}`);
  const match = route.pattern.exec(pathname);
  const params = {};
  route.keys.forEach((k, i) => {
    params[k] = decodeURIComponent(match[i + 1]);
  });
  const parsedQuery = query || Object.fromEntries(new URLSearchParams(qs || ''));

  return new Promise((resolve) => {
    let statusCode = 200;
    let settled = false;
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      resolve({ status: statusCode, body: payload });
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json: settle,
      send: settle
    };
    const req = { params, query: parsedQuery, body: body === undefined ? {} : body };
    try {
      const result = route.handler(req, res);
      if (result && typeof result.catch === 'function') {
        result.catch((e) => settle({ error: e.message }));
      }
    } catch (e) {
      settle({ error: e.message });
    }
  });
}

describe('plugin shape', () => {
  test('exposes the standard SignalK plugin interface', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'race-control-test-'));
    const plugin = pluginFactory(makeApp(dataDir));
    assert.equal(plugin.id, 'race-control');
    assert.equal(plugin.name, 'Race Control');
    assert.equal(typeof plugin.schema, 'object');
    assert.equal(typeof plugin.start, 'function');
    assert.equal(typeof plugin.stop, 'function');
    assert.equal(typeof plugin.registerWithRouter, 'function');
  });
});

describe('REST API — full race lifecycle', () => {
  let plugin;
  let router;
  let raceId;

  before(() => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'race-control-test-'));
    plugin = pluginFactory(makeApp(dataDir));
    plugin.start({});
    router = makeRouter();
    plugin.registerWithRouter(router);
  });

  after(() => {
    plugin.stop();
  });

  test('POST /races rejects a blank name', async () => {
    const res = await call(router, 'POST', '/races', { body: { name: '  ' } });
    assert.equal(res.status, 400);
  });

  test('POST /races creates a race and makes it current', async () => {
    const res = await call(router, 'POST', '/races', { body: { name: 'Onsdagsseilas' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.race.name, 'Onsdagsseilas');
    assert.equal(res.body.currentRaceId, res.body.race.id);
    assert.deepEqual(res.body.race.course, { startLine: null, marks: [], finishLine: null });
    raceId = res.body.race.id;
  });

  test('GET /races lists the created race', async () => {
    const res = await call(router, 'GET', '/races');
    assert.equal(res.status, 200);
    assert.ok(res.body.races.some((r) => r.id === raceId));
  });

  test('GET /races/:id 404s for an unknown id', async () => {
    const res = await call(router, 'GET', '/races/does-not-exist');
    assert.equal(res.status, 404);
  });

  test('GET /races/:id returns the full race', async () => {
    const res = await call(router, 'GET', `/races/${raceId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, raceId);
  });

  test('PUT /races/:id/course rejects an invalid mark', async () => {
    const res = await call(router, 'PUT', `/races/${raceId}/course`, {
      body: { marks: [{ lat: 'not a number', lon: 10.5 }] }
    });
    assert.equal(res.status, 400);
  });

  test('PUT /races/:id/course accepts a valid start/finish/marks', async () => {
    const res = await call(router, 'PUT', `/races/${raceId}/course`, {
      body: {
        startLine: [{ lat: 59.723876, lon: 10.543537, name: 'Pin' }, { lat: 59.7257498, lon: 10.5352725, name: 'Committee' }],
        finishLine: [{ lat: 59.681879, lon: 10.5640363 }, { lat: 59.6769532, lon: 10.5623646 }],
        marks: [{ id: 'm1', lat: 59.7, lon: 10.55, name: 'Mark 1' }]
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.course.marks.length, 1);
    assert.equal(res.body.course.startLine[0].name, 'Pin');
  });

  let boatId;
  let classId;

  test('POST /races/:id/boats rejects a blank name', async () => {
    const res = await call(router, 'POST', `/races/${raceId}/boats`, { body: { name: '' } });
    assert.equal(res.status, 400);
  });

  test('POST /races/:id/boats adds a boat', async () => {
    const res = await call(router, 'POST', `/races/${raceId}/boats`, { body: { name: 'RS 21 Solli' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'RS 21 Solli');
    assert.equal(res.body.finishTime, null);
    assert.equal(res.body.classId, null);
    boatId = res.body.id;
  });

  test('POST /races/:id/classes adds a class', async () => {
    const res = await call(router, 'POST', `/races/${raceId}/classes`, { body: { name: 'Cruisers' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.classes.length, 1);
    classId = res.body.classes[0].id;
  });

  test('PUT boat class rejects an unknown class id', async () => {
    const res = await call(router, 'PUT', `/races/${raceId}/boats/${boatId}/class`, { body: { classId: 'nope' } });
    assert.equal(res.status, 400);
  });

  test('PUT boat class assigns a real class', async () => {
    const res = await call(router, 'PUT', `/races/${raceId}/boats/${boatId}/class`, { body: { classId } });
    assert.equal(res.status, 200);
    assert.equal(res.body.classId, classId);
  });

  test("PUT class startTime sets the class's staggered start", async () => {
    const res = await call(router, 'PUT', `/races/${raceId}/classes/${classId}/startTime`, { body: { startTime: 5000 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.classes[0].startTime, 5000);
  });

  test('POST /races/:id/start sets startTime and resets courseActivated', async () => {
    const res = await call(router, 'POST', `/races/${raceId}/start`);
    assert.equal(res.status, 200);
    assert.ok(res.body.startTime > 0);
    assert.equal(res.body.courseActivated, false);
  });

  test('PUT boat finishTime rejects a non-numeric/zero value', async () => {
    const res = await call(router, 'PUT', `/races/${raceId}/boats/${boatId}/finishTime`, { body: { finishTime: 0 } });
    assert.equal(res.status, 400);
  });

  test('PUT boat finishTime records a finish and clears dnf/dns', async () => {
    const res = await call(router, 'PUT', `/races/${raceId}/boats/${boatId}/finishTime`, { body: { finishTime: Date.now() } });
    assert.equal(res.status, 200);
    assert.ok(res.body.finishTime > 0);
    assert.equal(res.body.dnf, false);
    assert.equal(res.body.dns, false);
  });

  test('PUT boat dnf clears the finish time it just set', async () => {
    const res = await call(router, 'PUT', `/races/${raceId}/boats/${boatId}/dnf`, { body: { dnf: true } });
    assert.equal(res.status, 200);
    assert.equal(res.body.dnf, true);
    assert.equal(res.body.finishTime, null);
  });

  test('PUT boat dns clears dnf (mutually exclusive states)', async () => {
    const res = await call(router, 'PUT', `/races/${raceId}/boats/${boatId}/dns`, { body: { dns: true } });
    assert.equal(res.status, 200);
    assert.equal(res.body.dns, true);
    assert.equal(res.body.dnf, false);
  });

  test('POST /races/:id/reset clears start time, class start times, and boat race state', async () => {
    const res = await call(router, 'POST', `/races/${raceId}/reset`);
    assert.equal(res.status, 200);
    assert.equal(res.body.startTime, null);
    assert.equal(res.body.classes[0].startTime, null);
    const boat = Object.values(res.body.boats)[0];
    assert.equal(boat.dns, false);
    assert.equal(boat.dnf, false);
    assert.equal(boat.finishTime, null);
    // Boats and their class assignment survive a reset — only race/start
    // state is cleared.
    assert.equal(boat.classId, classId);
  });

  test('DELETE boat removes it', async () => {
    const res = await call(router, 'DELETE', `/races/${raceId}/boats/${boatId}`);
    assert.equal(res.status, 200);
    const check = await call(router, 'GET', `/races/${raceId}`);
    assert.equal(Object.keys(check.body.boats).length, 0);
  });

  test('DELETE class 404s for an unknown class', async () => {
    const res = await call(router, 'DELETE', `/races/${raceId}/classes/nope`);
    assert.equal(res.status, 404);
  });

  test('DELETE class removes it', async () => {
    const res = await call(router, 'DELETE', `/races/${raceId}/classes/${classId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.classes.length, 0);
  });

  test('DELETE /races/:id removes the race entirely', async () => {
    const res = await call(router, 'DELETE', `/races/${raceId}`);
    assert.equal(res.status, 200);
    const check = await call(router, 'GET', `/races/${raceId}`);
    assert.equal(check.status, 404);
  });
});

describe('/overpass proxy — falls back across mirrors', () => {
  let plugin;
  let router;
  let originalFetch;

  before(() => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'race-control-test-'));
    plugin = pluginFactory(makeApp(dataDir));
    plugin.start({});
    router = makeRouter();
    plugin.registerWithRouter(router);
    originalFetch = global.fetch;
  });

  after(() => {
    plugin.stop();
    global.fetch = originalFetch;
  });

  test('400s when the query is missing', async () => {
    const res = await call(router, 'GET', '/overpass');
    assert.equal(res.status, 400);
  });

  test('falls through a failing mirror to the next and returns its data', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) throw new Error('mirror unreachable');
      return { ok: true, json: async () => ({ elements: [{ id: 1, tags: { 'seamark:name': 'Test Mark' } }] }) };
    };
    const res = await call(router, 'GET', '/overpass?data=%5Bout%3Ajson%5D');
    assert.equal(res.status, 200);
    assert.equal(res.body.elements[0].tags['seamark:name'], 'Test Mark');
    assert.ok(calls >= 2, 'expected at least 2 mirror attempts after the first failure');
  });

  test('returns an empty element list when every mirror fails', async () => {
    global.fetch = async () => {
      throw new Error('unreachable');
    };
    const res = await call(router, 'GET', '/overpass?data=%5Bout%3Ajson%5D');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.elements, []);
  });
});
