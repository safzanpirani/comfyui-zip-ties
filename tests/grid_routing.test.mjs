import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sourcePath = new URL('../web/zip_ties.js', import.meta.url);
let source = await readFile(sourcePath, 'utf8');
source = source.replace(
  /^import \{ app \} from .*;$/m,
  "const app = { extensionManager: { setting: { get: () => 'Rounded grid' } }, registerExtension() {} };",
);
source += '\nexport { gridRoute, roundedGridPath, state, DIR };\n';
globalThis.window = { LiteGraph: { CANVAS_GRID_SIZE: 10 } };
const extension = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function assertOrthogonal(points, label) {
  for (const point of points) assert.ok(point.every(Number.isFinite), `${label}: route points are finite`);
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    assert.ok(Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6, `${label}: leg ${i - 1} is axis aligned`);
  }
  for (let i = 2; i < points.length; i++) {
    const ax = points[i - 1][0] - points[i - 2][0];
    const ay = points[i - 1][1] - points[i - 2][1];
    const bx = points[i][0] - points[i - 1][0];
    const by = points[i][1] - points[i - 1][1];
    assert.ok(ax * bx + ay * by >= -1e-6, `${label}: adjacent collinear legs do not reverse`);
  }
}

function assertPortTangents(points, sd, ed, label) {
  const direction = new Map([
    [extension.DIR.UP, [0, -1]],
    [extension.DIR.DOWN, [0, 1]],
    [extension.DIR.LEFT, [-1, 0]],
    [extension.DIR.RIGHT, [1, 0]],
  ]);
  const first = points.slice(1).find(point => point[0] !== points[0][0] || point[1] !== points[0][1]);
  const lastIndex = points.length - 1;
  let last = lastIndex;
  while (last > 0 && points[last][0] === points[last - 1][0] && points[last][1] === points[last - 1][1]) last--;
  if (first) {
    const [dx, dy] = [first[0] - points[0][0], first[1] - points[0][1]];
    const [tx, ty] = direction.get(sd);
    assert.ok(dx * tx + dy * ty > 0, `${label}: first leg follows its output port`);
  }
  if (last > 0) {
    const [dx, dy] = [points[last][0] - points[last - 1][0], points[last][1] - points[last - 1][1]];
    const [tx, ty] = direction.get(ed);
    assert.ok(dx * -tx + dy * -ty > 0, `${label}: last leg enters against its input port direction`);
  }
}

function routeData(a, b, sd, ed, bounds = {}, key = 1) {
  return extension.gridRoute({ connections_width: 3 }, key, { a, b, sd, ed, ...bounds });
}

function route(a, b, sd, ed, bounds = {}) {
  extension.state.index.clear();
  extension.state.tieDirection.clear();
  const result = routeData(a, b, sd, ed, bounds);
  return Array.isArray(result) ? result : result.points;
}

test('grid routes preserve exact endpoints for every port direction pair, including close and reversed ends', () => {
  const dirs = [extension.DIR.UP, extension.DIR.DOWN, extension.DIR.LEFT, extension.DIR.RIGHT];
  const ends = [
    [[0, 0], [18, -100]],
    [[1, 1], [3, 3]],
    [[0, 0], [20, 0]],
    [[100, 70], [10, 10]],
    [[40, 40], [40, 40]],
  ];
  for (const [a, b] of ends) {
    for (const sd of dirs) {
      for (const ed of dirs) {
        const points = route(a, b, sd, ed);
        assert.deepEqual(points[0], a);
        assert.deepEqual(points.at(-1), b);
        assertOrthogonal(points, `${a}/${b}, ${sd}/${ed}`);
        assertPortTangents(points, sd, ed, `${a}/${b}, ${sd}/${ed}`);
      }
    }
  }
});

test('backward routes detour toward the input while clearing source and target bounds', () => {
  const sourceBox = [100, 100, 180, 400];
  const cases = [
    { targetBox: [0, 40, 70, 80], b: [0, 80], side: 'above' },
    { targetBox: [0, 550, 70, 80], b: [0, 590], side: 'below' },
  ];
  for (const { targetBox, b, side } of cases) {
    const a = [280, 300];
    const points = route(a, b, extension.DIR.RIGHT, extension.DIR.LEFT, { sourceBox, targetBox });
    assert.deepEqual(points[0], a);
    assert.deepEqual(points.at(-1), b);
    assertOrthogonal(points, `backward target ${side}`);
    assertPortTangents(points, extension.DIR.RIGHT, extension.DIR.LEFT, `backward target ${side}`);

    const crossing = points.slice(1).map((point, i) => [points[i], point]).find(([p, q]) =>
      Math.abs(p[1] - q[1]) < 1e-6 && Math.max(p[0], q[0]) > sourceBox[0] && Math.min(p[0], q[0]) < sourceBox[0] + sourceBox[2]);
    assert.ok(crossing, `${side}: route uses a corridor across the source's horizontal span`);
    assert.ok(side === 'above' ? crossing[0][1] < sourceBox[1] : crossing[0][1] > sourceBox[1] + sourceBox[3],
      `${side}: route clears the tall source on the side facing the input`);

    const boxes = [sourceBox, targetBox];
    for (let i = 1; i < points.length; i++) {
      const [p, q] = [points[i - 1], points[i]];
      for (const box of boxes) {
        for (let t = 0.05; t < 1; t += 0.1) {
          const x = p[0] + (q[0] - p[0]) * t;
          const y = p[1] + (q[1] - p[1]) * t;
          assert.ok(!(x > box[0] && x < box[0] + box[2] && y > box[1] && y < box[1] + box[3]),
            `${side}: segment ${i - 1} avoids endpoint node body`);
        }
      }
    }
  }
});

test('a narrow vertical gap between endpoint boxes gets a safe shared corridor', () => {
  const sourceBox = [0, 140, 100, 100];
  const targetBox = [50, 0, 200, 100];
  const points = route([100, 190], [50, 50], extension.DIR.RIGHT, extension.DIR.LEFT, { sourceBox, targetBox });
  assert.deepEqual(points[0], [100, 190]);
  assert.deepEqual(points.at(-1), [50, 50]);
  assertOrthogonal(points, 'vertical endpoint gap');
  assertPortTangents(points, extension.DIR.RIGHT, extension.DIR.LEFT, 'vertical endpoint gap');
  assert.ok(points.some(point => Math.abs(point[1] - 120) < 1e-6), 'route uses the middle of the 40px gap');
});

test('a 20px endpoint gap keeps the shared corridor between both boxes', () => {
  const sourceBox = [0, 120, 100, 100];
  const targetBox = [50, 0, 200, 100];
  const points = route([100, 170], [50, 50], extension.DIR.RIGHT, extension.DIR.LEFT, { sourceBox, targetBox });
  assert.deepEqual(points[0], [100, 170]);
  assert.deepEqual(points.at(-1), [50, 50]);
  assertOrthogonal(points, 'narrow vertical endpoint gap');
  assert.ok(points.some(point => point[1] > targetBox[1] + targetBox[3] && point[1] < sourceBox[1]),
    'route uses the remaining vertical gap with clearance from both boxes');
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    for (const box of [sourceBox, targetBox]) {
      for (let t = 0.05; t < 1; t += 0.1) {
        const x = a[0] + (b[0] - a[0]) * t;
        const y = a[1] + (b[1] - a[1]) * t;
        assert.ok(!(x > box[0] && x < box[0] + box[2] && y > box[1] && y < box[1] + box[3]),
          'narrow-gap detour avoids both node bodies');
      }
    }
  }
});

test('overlapping endpoint bounds remain routable with exact endpoints', () => {
  const points = route([280, 300], [250, 320], extension.DIR.RIGHT, extension.DIR.LEFT, {
    sourceBox: [100, 100, 180, 400],
    targetBox: [250, 250, 140, 100],
  });
  assert.deepEqual(points[0], [280, 300]);
  assert.deepEqual(points.at(-1), [250, 320]);
  assertOrthogonal(points, 'overlapping endpoint bounds');
});

test('reroute segments still use local port directions without endpoint node boxes', () => {
  const points = route([300, 220], [120, 260], extension.DIR.CENTER, extension.DIR.CENTER);
  assert.deepEqual(points[0], [300, 220]);
  assert.deepEqual(points.at(-1), [120, 260]);
  assertOrthogonal(points, 'reroute segment');
});

test('two spaced ties on one wire keep parallel members on distinct orthogonal lanes', () => {
  const links = [1, 2];
  const ties = [
    { pos: [30, 0], angle: 0, links },
    { pos: [80, 35], angle: 0, links },
  ];
  const members = links.map(key => {
    extension.state.index.set(key, ties);
    return extension.gridRoute({ connections_width: 3 }, key, {
      a: [0, 0], b: [120, 40], sd: extension.DIR.RIGHT, ed: extension.DIR.LEFT,
    }).points;
  });
  for (let i = 0; i < members.length; i++) assertOrthogonal(members[i], `member ${links[i]}`);
  const crossingAt = y => members.map(points => {
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]];
      if (Math.abs(a[0] - b[0]) < 1e-6 && Math.min(a[1], b[1]) < y && Math.max(a[1], b[1]) > y) return a[0];
    }
    return null;
  });
  const lanes = crossingAt(17.5);
  assert.ok(lanes.every(Number.isFinite), 'both routes cross the space between the ties');
  assert.notEqual(lanes[0], lanes[1], 'parallel members use separate trunk lanes between ties');
});

test('wide tied bundles route every strand without diagonal legs or U-turns', () => {
  const links = Array.from({ length: 20 }, (_, i) => i + 1);
  const tie = { pos: [80, 2], angle: Math.PI / 2, links };
  for (const key of links) {
    extension.state.index.set(key, [tie]);
    const points = extension.gridRoute({ connections_width: 3 }, key, {
      a: [0, 0], b: [100, 4], sd: extension.DIR.RIGHT, ed: extension.DIR.LEFT,
    }).points;
    assert.deepEqual(points[0], [0, 0]);
    assert.deepEqual(points.at(-1), [100, 4]);
    assertOrthogonal(points, `20-strand member ${key}`);
  }
});

test('opposite fanout directions keep vertical tie strands distinct', () => {
  extension.state.index.clear();
  extension.state.tieDirection.clear();
  const links = [1, 2];
  const tie = { pos: [200, 100], angle: Math.PI / 2, links };
  const endpoints = [
    { a: [0, 0], b: [300, -100] },
    { a: [0, 0], b: [300, 300] },
  ];
  const routes = links.map((key, i) => {
    extension.state.index.set(key, [tie]);
    const { a, b } = endpoints[i];
    const result = routeData(a, b, extension.DIR.RIGHT, extension.DIR.LEFT, {}, key);
    assert.deepEqual(result.points[0], a);
    assert.deepEqual(result.points.at(-1), b);
    assertOrthogonal(result.points, `fanout ${i}`);
    return result;
  });
  const strandPoints = routes.map(result => result.points.reduce((closest, point) =>
    Math.hypot(point[0] - tie.pos[0], point[1] - tie.pos[1]) < Math.hypot(closest[0] - tie.pos[0], closest[1] - tie.pos[1]) ? point : closest,
  result.points[0]));
  assert.ok(Math.hypot(strandPoints[0][0] - strandPoints[1][0], strandPoints[0][1] - strandPoints[1][1]) > 1,
    `opposite input fanouts do not collapse onto the same tie strand point: ${JSON.stringify({ strandPoints, routes })}`);
});

test('an adjacent horizontal tie fixes the shared vertical tangent for opposite fanouts', () => {
  const links = [1, 2];
  extension.state.index.clear();
  extension.state.tieDirection.clear();
  const ties = [
    { pos: [100, 0], angle: 0, links },
    { pos: [200, 100], angle: Math.PI / 2, links },
  ];
  const ends = [[300, -100], [300, 300]];
  const routes = links.map((key, index) => {
    extension.state.index.set(key, ties);
    return routeData([0, 0], ends[index], extension.DIR.RIGHT, extension.DIR.LEFT, {}, key);
  });
  for (let i = 0; i < routes.length; i++) {
    assert.deepEqual(routes[i].points[0], [0, 0]);
    assert.deepEqual(routes[i].points.at(-1), ends[i]);
    assertOrthogonal(routes[i].points, `adjacent tie fanout ${i}`);
  }
  const strandPoints = routes.map(result => result.points.reduce((closest, point) =>
    Math.hypot(point[0] - ties[1].pos[0], point[1] - ties[1].pos[1]) < Math.hypot(closest[0] - ties[1].pos[0], closest[1] - ties[1].pos[1]) ? point : closest,
  result.points[0]));
  assert.ok(Math.hypot(strandPoints[0][0] - strandPoints[1][0], strandPoints[0][1] - strandPoints[1][1]) > 1,
    'opposite final fanouts preserve distinct strands through the vertical tie');
});

test('180 degree tie equivalents preserve lane geometry for horizontal and vertical axes', () => {
  const links = [1, 2, 3];
  const geometry = angle => links.map(key => {
    extension.state.index.delete(key);
    const tie = { pos: [100, 30], angle, links };
    extension.state.index.set(key, [tie]);
    return routeData([0, 0], [200, 70], extension.DIR.RIGHT, extension.DIR.LEFT, {}, key);
  });
  assert.deepEqual(geometry(0), geometry(Math.PI), '0° and 180° ties keep the same strand order');
  assert.deepEqual(geometry(Math.PI / 2), geometry(-Math.PI / 2), '+90° and -90° ties keep the same strand order');
});

test('bundle quarter turns share a center and keep radii ordered in both directions', () => {
  const links = [1, 2, 3, 4, 5];
  for (const sign of [1, -1]) {
    const build = angleShift => {
      extension.state.index.clear();
      extension.state.tieDirection.clear();
      const ties = [
        { pos: [30, 0], angle: angleShift, links },
        { pos: [80, sign * 50], angle: sign * Math.PI / 2 + angleShift, links },
      ];
      return links.map(key => {
        extension.state.index.set(key, ties);
        return routeData([0, 0], [120, sign * 100], extension.DIR.RIGHT,
          sign > 0 ? extension.DIR.UP : extension.DIR.DOWN, {}, key);
      });
    };
    const results = build(0);
    const halfTurn = build(Math.PI);
    assert.deepEqual(halfTurn, results, `turn ${sign}: adding 180° preserves lane paths and signed radii`);
    const centers = [];
    const radii = [];
    for (const result of results) {
      let current;
      const arcs = [];
      const path = {
        moveTo: (...point) => { current = point; },
        lineTo: (...point) => { current = point; },
        quadraticCurveTo: (cx, cy, x, y) => {
          const dxIn = cx - current[0], dyIn = cy - current[1];
          const dxOut = x - cx, dyOut = y - cy;
          const turn = Math.sign(dxIn * dyOut - dyIn * dxOut);
          const radius = Math.hypot(dxIn, dyIn);
          const center = Math.abs(dxIn) > Math.abs(dyIn)
            ? [cx - Math.sign(dxIn) * radius, cy + Math.sign(dyOut) * radius]
            : [cx + Math.sign(dxOut) * radius, cy - Math.sign(dyIn) * radius];
          arcs.push({ turn, radius, center });
          current = [x, y];
        },
      };
      extension.roundedGridPath(path, result);
      const target = [59, sign * 21];
      const bend = arcs.find(arc => arc.turn === sign && Math.hypot(arc.center[0] - target[0], arc.center[1] - target[1]) < 1e-6);
      assert.ok(bend, `turn ${sign}: each strand contains the shared bend`);
      centers.push(bend.center);
      radii.push(bend.radius);
      assertOrthogonal(result.points, `bundle turn ${sign}`);
    }
    assert.ok(centers.every(center => Math.hypot(center[0] - centers[0][0], center[1] - centers[0][1]) < 1e-6),
      `turn ${sign}: all strands share one bend center`);
    for (let i = 1; i < radii.length; i++) {
      assert.ok(sign > 0 ? radii[i] < radii[i - 1] : radii[i] > radii[i - 1],
        `turn ${sign}: concentric radii remain ordered without crossing`);
    }
  }
});

test('rounded path emits quadratic corners along the same route geometry', () => {
  const commands = [];
  const path = {
    moveTo: (...p) => commands.push(['moveTo', ...p]),
    lineTo: (...p) => commands.push(['lineTo', ...p]),
    quadraticCurveTo: (...p) => commands.push(['quadraticCurveTo', ...p]),
  };
  const points = [[0, 0], [50, 0], [50, 60], [100, 60]];
  const traced = extension.roundedGridPath(path, { points, lanes: [0, 0, 0, 0], halfWidths: [0, 0, 0, 0] });
  assert.ok(commands.some(command => command[0] === 'quadraticCurveTo'));
  assert.deepEqual(traced[0], points[0]);
  assert.deepEqual(traced.at(-1), points.at(-1));
});
