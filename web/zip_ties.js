import { app } from "../../scripts/app.js";

// Zip ties: hold Z and drag across wires to bundle them into a ribbon.
// Drag a tie to move it, Shift-drag to rotate it, right-click it for colours.
// Z-drag across a tie, or double-click it, to cut it.
//
// A tie holds "members". A number is a link id: the whole link, or for a link that passes through
// reroutes, its last segment (last reroute to input). A string "r<id>" is the segment that ends at
// reroute <id>; reroute segments are shared by every link through that reroute.

const EXTRA_KEY = "zipTies";
const CLIPBOARD_KEY = "zipTies";
const DIR = { NONE: 0, UP: 1, DOWN: 2, LEFT: 3, RIGHT: 4, CENTER: 5 };
const MARKER_NONE = 0;
const CONTROL_FACTOR = 0.25;
const SAMPLES = 32;
const BAR_HALF_WIDTH = 2.5;
const BAR_PAD = 3;
const HEAD_HALF_WIDTH = 4;
const HEAD_LENGTH = 6;
const HIT_PAD_PX = 6;
const DOUBLE_CLICK_MS = 350;
const SNAP = Math.PI / 12; // 15°
const HIDDEN_LINK = -1;

const GREY = "#8c8c94";
const CUT_RED = "#ff3b3b";
const PREVIEW_WHITE = "#ffffff";
const WIRES = "wires"; // tie.color value: take the colour of the wires it holds
const PALETTE = [
  ["Red", "#e5484d"],
  ["Orange", "#f76b15"],
  ["Yellow", "#ffc53d"],
  ["Green", "#46a758"],
  ["Teal", "#12a594"],
  ["Blue", "#3e63dd"],
  ["Purple", "#8e4ec6"],
  ["Pink", "#d6409f"],
  ["White", "#ededed"],
  ["Black", "#232326"],
];
const COLOR_SETTING = "ZipTies.NewTieColor";
const COLOR_MODE = { RANDOM: "Random", WIRES: "Match wires", GREY: "Grey" };
const KEY_SETTING = "ZipTies.Key";
const ROUTING_SETTING = "ZipTies.WireRouting";
const GRID_ROUTING = "Rounded grid";
// Letters ComfyUI does not bind on their own (it binds r w n m a p v h).
const KEYS = ["Z", "X", "C", "G", "T", "Y"];

const state = {
  keyHeld: false,
  armed: false, // "Tie wires" from the canvas menu: the next drag is a tie stroke
  pointerDown: false,
  hovered: null, // tie id
  drag: null, // { tie, dx, dy, pointerId, moved, rotate, offset }
  cut: null, // { start, client, pointerId, last }
  preview: null, // { keys: Set, cutTies: Set } while a stroke is in progress
  previewFrame: 0,
  lastDown: { id: null, time: 0 },
  rendering: false,
  rendered: false, // set by renderLink, read by the culling fallback
  endpoints: new Map(), // member key -> { a, b, sd, ed, startControl, endControl } from the last frame
  tieDirection: new Map(), // tie -> travel sign shared by its strands in this frame
  linkColors: new Map(), // member key -> colour the wire was drawn in last frame
  index: new Map(), // member key -> ties[]
  sigs: new Map(), // tied link id -> "origin:slot>target:slot", to follow a wire that is reconnected
  anchorPos: new Map(), // anchor key -> [x, y] last frame, for nodes and reroutes on tied wires
  anchorPosFor: null, // the ties array anchorPos was recorded against
  overlay: null,
  selected: new Set(), // selected ties
  liveSelectBase: null, // tie selection when a live rubber-band selection started
  groupBox: new Map(), // group -> { pos, size } last frame
  selectionPos: new Map(), // selected canvas item -> [x, y] last frame
};

function setting(id, fallback) {
  try {
    return app.extensionManager?.setting?.get?.(id) ?? app.ui?.settings?.getSettingValue?.(id) ?? fallback;
  } catch {
    return fallback;
  }
}

function tieKeyCode() {
  const key = setting(KEY_SETTING, "Z");
  return `Key${KEYS.includes(key) ? key : "Z"}`;
}

function linksHidden(canvas) {
  return canvas.links_render_mode === (window.LiteGraph?.HIDDEN_LINK ?? HIDDEN_LINK);
}

// ---------- data ----------

function tiesOf(graph, create = false) {
  if (!graph) return [];
  graph.extra ??= {};
  let ties = graph.extra[EXTRA_KEY];
  if (!Array.isArray(ties)) {
    if (!create) return [];
    ties = graph.extra[EXTRA_KEY] = [];
  }
  return ties;
}

function getLink(graph, id) {
  return graph.getLink?.(id) ?? (graph.links instanceof Map ? graph.links.get(id) : graph.links?.[id]);
}

function getReroute(graph, id) {
  return graph.getReroute?.(id) ?? graph.reroutes?.get?.(id);
}

function allLinks(graph) {
  const links = graph.links;
  if (!links) return [];
  return links instanceof Map ? [...links.values()] : Object.values(links);
}

function isRerouteKey(key) {
  return typeof key === "string" && key[0] === "r";
}

function rerouteKey(id) {
  return `r${id}`;
}

function rerouteIdOf(key) {
  return Number(key.slice(1));
}

function memberExists(graph, key) {
  return isRerouteKey(key) ? !!getReroute(graph, rerouteIdOf(key)) : !!getLink(graph, key);
}

function validTie(tie) {
  return !!tie && Array.isArray(tie.links) && Array.isArray(tie.pos) && Number.isFinite(tie.pos[0]) && Number.isFinite(tie.pos[1]);
}

/** A tie shows, and can be clicked, while at least one of its wires was drawn in the last frame. */
function tieShown(tie) {
  return tie.links.some((key) => state.endpoints.has(key));
}

function linkSig(link) {
  return `${link.origin_id}:${link.origin_slot}>${link.target_id}:${link.target_slot}`;
}

function nextTieId(ties) {
  let id = 1;
  for (const t of ties) id = Math.max(id, t.id + 1);
  return id;
}

function newTieColor(ties) {
  const mode = setting(COLOR_SETTING, COLOR_MODE.RANDOM);
  if (mode === COLOR_MODE.WIRES) return WIRES;
  if (mode === COLOR_MODE.GREY) return undefined;
  const last = ties.at(-1)?.color;
  // Black disappears on the dark canvas, so random picks skip it; it stays in the tie menu.
  const pool = PALETTE.filter(([name, c]) => name !== "Black" && c !== last);
  return pool[Math.floor(Math.random() * pool.length)][1];
}

/**
 * Drops members that no longer exist, removes empty ties, rebuilds the index.
 * A wire reconnected between the same two slots gets a new link id; it keeps its place in the ribbon.
 * While a pointer is down, missing members are kept, since a wire being dragged may be on its way back.
 */
function syncTies(graph) {
  state.index.clear();
  const ties = tiesOf(graph);
  // Workflows come from anywhere; a malformed entry is dropped rather than breaking every frame.
  for (let i = ties.length - 1; i >= 0; i--) if (!validTie(ties[i])) ties.splice(i, 1);
  if (!ties.length) {
    state.sigs.clear();
    if (graph?.extra) delete graph.extra[EXTRA_KEY];
    return;
  }
  let bySig = null;
  for (let i = ties.length - 1; i >= 0; i--) {
    const tie = ties[i];
    const kept = [];
    for (const key of tie.links) {
      if (kept.includes(key)) continue;
      if (memberExists(graph, key)) {
        kept.push(key);
        continue;
      }
      const sig = isRerouteKey(key) ? null : state.sigs.get(key);
      if (sig) {
        bySig ??= new Map(allLinks(graph).map((l) => [linkSig(l), l]));
        const twin = bySig.get(sig);
        if (twin && !tie.links.includes(twin.id) && !kept.includes(twin.id)) {
          kept.push(twin.id);
          continue;
        }
      }
      if (state.pointerDown) kept.push(key);
    }
    tie.links = kept;
    if (!kept.length) ties.splice(i, 1);
  }
  const sigs = new Map();
  for (const tie of ties) {
    for (const key of tie.links) {
      if (!isRerouteKey(key)) {
        const link = getLink(graph, key);
        const sig = link ? linkSig(link) : state.sigs.get(key);
        if (sig) sigs.set(key, sig);
      }
      if (!memberExists(graph, key)) continue;
      let list = state.index.get(key);
      if (!list) state.index.set(key, (list = []));
      list.push(tie);
    }
  }
  state.sigs = sigs;
  if (!ties.length) delete graph.extra[EXTRA_KEY];
}

function endpointNode(graph, id) {
  return graph.getNodeById?.(id) ?? (id === -10 ? graph.inputNode : id === -20 ? graph.outputNode : null);
}

/** The nodes and reroutes a member's segment runs between, as "n<id>" / "r<id>" anchor keys. */
function anchorsOf(graph, key) {
  if (isRerouteKey(key)) {
    const reroute = getReroute(graph, rerouteIdOf(key));
    if (!reroute) return [];
    if (reroute.parentId != null) return [key, rerouteKey(reroute.parentId)];
    const linkId = reroute.linkIds?.values?.().next().value;
    const link = linkId != null ? getLink(graph, linkId) : null;
    return link ? [key, `n${link.origin_id}`] : [key];
  }
  const link = getLink(graph, key);
  if (!link) return [];
  const start = link.parentId != null ? rerouteKey(link.parentId) : `n${link.origin_id}`;
  return [start, `n${link.target_id}`];
}

function anchorId(anchor) {
  const raw = anchor.slice(1);
  const num = Number(raw);
  return Number.isNaN(num) ? raw : num;
}

function anchorPosition(graph, anchor) {
  const pos = anchor[0] === "r" ? getReroute(graph, anchorId(anchor))?.pos : endpointNode(graph, anchorId(anchor))?.pos;
  return pos ? [pos[0], pos[1]] : null;
}

function shiftTie(tie, d) {
  tie.pos = [tie.pos[0] + d[0], tie.pos[1] + d[1]];
}

function insideBox(p, box) {
  return p[0] >= box.pos[0] && p[0] <= box.pos[0] + box.size[0] && p[1] >= box.pos[1] && p[1] <= box.pos[1] + box.size[1];
}

/**
 * Moves the ties inside a group by as much as the group moved since the last frame. A group that
 * changed size was resized or refitted rather than moved, and a Ctrl/Cmd-drag moves only the frame.
 */
function followGroups(canvas, graph, ties, moved) {
  const mods = canvas._lastDragModifiers;
  const frameOnly = canvas.isDragging && (mods?.ctrlKey || mods?.metaKey);
  const current = new Map();
  for (const group of graph._groups ?? graph.groups ?? []) {
    if (!group?.pos || !group.size) continue;
    const box = { pos: [group.pos[0], group.pos[1]], size: [group.size[0], group.size[1]] };
    current.set(group, box);
    const before = state.groupBox.get(group);
    if (!before || frameOnly) continue;
    const d = [box.pos[0] - before.pos[0], box.pos[1] - before.pos[1]];
    if (!d[0] && !d[1]) continue;
    if (box.size[0] !== before.size[0] || box.size[1] !== before.size[1]) continue;
    for (const tie of ties) {
      if (moved.has(tie) || tie === state.drag?.tie || !insideBox(tie.pos, before)) continue;
      shiftTie(tie, d);
      moved.add(tie);
    }
  }
  state.groupBox = current;
}

/** Moves selected ties along when every selected canvas item moved by the same amount since the last frame. */
function followSelection(canvas, moved) {
  const current = new Map();
  let delta = null;
  let same = true;
  for (const item of canvas.selectedItems ?? []) {
    if (!item?.pos) continue;
    const now = [item.pos[0], item.pos[1]];
    current.set(item, now);
    const before = state.selectionPos.get(item);
    if (!before) {
      same = false;
      continue;
    }
    const d = [now[0] - before[0], now[1] - before[1]];
    if (!delta) delta = d;
    else if (Math.abs(d[0] - delta[0]) > 0.01 || Math.abs(d[1] - delta[1]) > 0.01) same = false;
  }
  state.selectionPos = current;
  if (!state.selected.size || !same || !delta || (!delta[0] && !delta[1])) return;
  for (const tie of state.selected) {
    if (moved.has(tie) || tie === state.drag?.tie) continue;
    shiftTie(tie, delta);
    moved.add(tie);
  }
}

/** Moves a tie with its wires when every node and reroute on those wires moved by the same amount since the last frame. */
function followAnchors(graph, ties, moved) {
  if (state.anchorPosFor !== ties) {
    // A loaded, undone or replaced tie list: positions from before are not comparable.
    state.anchorPosFor = ties;
    state.anchorPos.clear();
  }
  const current = new Map();
  const posOf = (anchor) => {
    if (!current.has(anchor)) current.set(anchor, anchorPosition(graph, anchor));
    return current.get(anchor);
  };
  for (const tie of ties) {
    let delta = null;
    let follow = tie !== state.drag?.tie && !moved.has(tie);
    for (const key of tie.links) {
      for (const anchor of anchorsOf(graph, key)) {
        const now = posOf(anchor);
        const before = state.anchorPos.get(anchor);
        if (!now || !before) {
          follow = false;
          continue;
        }
        const d = [now[0] - before[0], now[1] - before[1]];
        if (!delta) delta = d;
        else if (Math.abs(d[0] - delta[0]) > 0.01 || Math.abs(d[1] - delta[1]) > 0.01) follow = false;
      }
    }
    if (follow && delta && (delta[0] || delta[1])) shiftTie(tie, delta);
  }
  state.anchorPos = current;
}

/** Runs once per frame: ties follow moved groups, the dragged selection, then their wires' ends. */
function followMoves(canvas, graph) {
  const ties = tiesOf(graph);
  for (const tie of state.selected) if (!ties.includes(tie)) state.selected.delete(tie);
  const moved = new Set();
  followGroups(canvas, graph, ties, moved);
  followSelection(canvas, moved);
  followAnchors(graph, ties, moved);
}

// ---------- selection ----------

function normalizedRect(rect) {
  const x = rect[2] < 0 ? rect[0] + rect[2] : rect[0];
  const y = rect[3] < 0 ? rect[1] + rect[3] : rect[1];
  return { pos: [x, y], size: [Math.abs(rect[2]), Math.abs(rect[3])] };
}

/** Applies a rubber-band selection to ties with litegraph's modifiers: Shift adds, Alt removes, otherwise replace. */
function selectTiesInRect(canvas, e, rect, base) {
  const box = normalizedRect(rect);
  const inRect = tiesOf(canvas.graph).filter((t) => tieShown(t) && insideBox(t.pos, box));
  let next;
  if (e?.shiftKey && !e.altKey) next = new Set([...base, ...inRect]);
  else if (e?.altKey && !e.shiftKey) next = new Set([...base].filter((t) => !inRect.includes(t)));
  else next = new Set(inRect);
  state.selected = next;
  canvas.setDirty(true, true);
}

function removeTies(canvas, graph, ties) {
  graph.extra[EXTRA_KEY] = tiesOf(graph).filter((t) => !ties.has(t));
  state.selected.clear();
  state.hovered = null;
  syncTies(graph);
}

function installSelection(canvas) {
  const proto = Object.getPrototypeOf(canvas);

  const origDeselectAll = proto.deselectAll;
  if (origDeselectAll) {
    proto.deselectAll = function (...args) {
      if (this === canvas) state.selected.clear();
      return origDeselectAll.apply(this, args);
    };
  }

  const origLive = proto.handleLiveSelect;
  if (origLive) {
    proto.handleLiveSelect = function (e, dragRect, ...rest) {
      const r = origLive.call(this, e, dragRect, ...rest);
      if (this === canvas && this.graph) {
        state.liveSelectBase ??= new Set(state.selected);
        selectTiesInRect(this, e, dragRect, state.liveSelectBase);
      }
      return r;
    };
  }

  const origMulti = proto._handleMultiSelect;
  if (origMulti) {
    proto._handleMultiSelect = function (e, dragRect, ...rest) {
      const base = new Set(state.selected);
      const r = origMulti.call(this, e, dragRect, ...rest);
      if (this === canvas && this.graph) selectTiesInRect(this, e, dragRect, base);
      return r;
    };
  }

  const origDelete = proto.deleteSelected;
  if (origDelete) {
    // One change for the selected ties and the selected nodes, so a single undo restores both.
    proto.deleteSelected = function (...args) {
      const graph = this.graph;
      if (this !== canvas || !graph || !state.selected.size) return origDelete.apply(this, args);
      graph.beforeChange?.();
      this.emitBeforeChange?.();
      try {
        removeTies(this, graph, new Set(state.selected));
        return origDelete.apply(this, args);
      } finally {
        graph.afterChange?.();
        this.emitAfterChange?.();
      }
    };
  }
}

function commit(canvas) {
  canvas.setDirty(true, true);
  const ct = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
  const capture = ct?.captureCanvasState ?? ct?.checkState;
  if (capture) capture.call(ct);
  else window.dispatchEvent(new MouseEvent("mouseup"));
}

// ---------- geometry ----------

function spacing(canvas) {
  return (canvas.connections_width ?? 3) + 1.5;
}

function tieAngle(tie) {
  const angle = tie.angle ?? 0;
  return setting(ROUTING_SETTING, "Default") === GRID_ROUTING ? Math.round(angle / (Math.PI / 2)) * (Math.PI / 2) : angle;
}

function tieAxes(tie) {
  if (setting(ROUTING_SETTING, "Default") === GRID_ROUTING) {
    const quarter = ((Math.round((tie.angle ?? 0) / (Math.PI / 2)) % 4) + 4) % 4;
    const axes = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const t = axes[quarter];
    return { t, n: [-t[1], t[0]] };
  }
  const c = Math.cos(tie.angle ?? 0);
  const s = Math.sin(tie.angle ?? 0);
  return { t: [c, s], n: [-s, c] };
}

function tieHalfLength(canvas, tie) {
  return ((tie.links.length - 1) * spacing(canvas)) / 2 + BAR_PAD;
}

function strandPoint(canvas, tie, key) {
  const i = tie.links.indexOf(key);
  const off = (i - (tie.links.length - 1) / 2) * spacing(canvas);
  const { n } = tieAxes(tie);
  return [tie.pos[0] + n[0] * off, tie.pos[1] + n[1] * off];
}

/** Ties on this segment, ordered from its start to its end. */
function orderedTies(key, a, b) {
  const list = state.index.get(key);
  if (!list?.length) return [];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return list.toSorted(
    (p, q) => (p.pos[0] - a[0]) * dx + (p.pos[1] - a[1]) * dy - ((q.pos[0] - a[0]) * dx + (q.pos[1] - a[1]) * dy),
  );
}

/** Sub-segments one rendered segment is drawn as, in renderLink terms. The outer ends keep their original controls. */
function route(canvas, key, seg) {
  const ties = orderedTies(key, seg.a, seg.b);
  if (!ties.length) return [seg];
  const pts = ties.map((t) => ({ p: strandPoint(canvas, t, key), dir: tieAxes(t).t }));
  const segs = [];
  let prev = { p: seg.a, dir: null };
  for (const cur of [...pts, { p: seg.b, dir: null }]) {
    const dist = Math.hypot(cur.p[0] - prev.p[0], cur.p[1] - prev.p[1]) * CONTROL_FACTOR;
    const sub = { a: prev.p, b: cur.p, sd: prev.dir ? DIR.CENTER : seg.sd, ed: cur.dir ? DIR.CENTER : seg.ed };
    if (prev.dir) sub.startControl = [prev.dir[0] * dist, prev.dir[1] * dist];
    else if (seg.startControl) sub.startControl = seg.startControl;
    if (cur.dir) sub.endControl = [-cur.dir[0] * dist, -cur.dir[1] * dist];
    else if (seg.endControl) sub.endControl = seg.endControl;
    segs.push(sub);
    prev = cur;
  }
  return segs;
}

function offsetByDir(p, dir, d) {
  switch (dir) {
    case DIR.LEFT: return [p[0] - d, p[1]];
    case DIR.RIGHT: return [p[0] + d, p[1]];
    case DIR.UP: return [p[0], p[1] - d];
    case DIR.DOWN: return [p[0], p[1] + d];
    default: return [p[0], p[1]];
  }
}

function gridDirection(dir) {
  switch (dir) {
    case DIR.LEFT: return [-1, 0];
    case DIR.RIGHT: return [1, 0];
    case DIR.UP: return [0, -1];
    case DIR.DOWN: return [0, 1];
    default: return null;
  }
}

function addGridPoint(points, p) {
  const last = points.at(-1);
  if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) return;
  const prev = points.at(-2);
  if (prev && ((prev[0] === last[0] && last[0] === p[0]) || (prev[1] === last[1] && last[1] === p[1]))) {
    if ((last[0] - prev[0]) * (p[0] - last[0]) + (last[1] - prev[1]) * (p[1] - last[1]) > 0) points.pop();
  }
  points.push(p);
}

/** One orthogonal route through the strand positions. Port and tie tangents set the first and last leg. */
function gridRoute(canvas, key, seg) {
  const gridSize = window.LiteGraph?.CANVAS_GRID_SIZE ?? 10;
  const snap = (value) => Math.round(value / gridSize) * gridSize;
  const ties = orderedTies(key, seg.a, seg.b);
  const stops = [
    { p: seg.a, tangent: gridDirection(seg.sd) },
    ...ties.map((tie, index) => {
      let { t, n } = tieAxes(tie);
      if (t[0] < 0 || t[1] < 0) {
        t = [-t[0], -t[1]];
        n = [-n[0], -n[1]];
      }
      let direction = state.tieDirection.get(tie);
      if (direction == null) {
        const next = ties[index + 1], prev = ties[index - 1];
        const nextAlong = next ? t[0] * (next.pos[0] - tie.pos[0]) + t[1] * (next.pos[1] - tie.pos[1]) : 0;
        const prevAlong = prev ? t[0] * (tie.pos[0] - prev.pos[0]) + t[1] * (tie.pos[1] - prev.pos[1]) : 0;
        direction = Math.sign(nextAlong || prevAlong || t[0] * (seg.b[0] - seg.a[0]) + t[1] * (seg.b[1] - seg.a[1])) || 1;
        state.tieDirection.set(tie, direction);
      }
      if (direction < 0) {
        t = [-t[0], -t[1]];
        n = [-n[0], -n[1]];
      }
      const lane = (tie.links.indexOf(key) - (tie.links.length - 1) / 2) * spacing(canvas);
      return { p: [tie.pos[0] + n[0] * lane, tie.pos[1] + n[1] * lane], tangent: t, lane, halfWidth: (tie.links.length - 1) * spacing(canvas) / 2 };
    }),
    { p: seg.b, tangent: gridDirection(seg.ed)?.map((v) => -v) },
  ];
  const points = [stops[0].p];
  const lanes = [0], halfWidths = [0];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    const lane = a.lane ?? b.lane ?? 0;
    const halfWidth = Math.max(a.halfWidth ?? 0, b.halfWidth ?? 0);
    const add = (p) => {
      addGridPoint(points, p);
      lanes.length = points.length;
      halfWidths.length = points.length;
      lanes[points.length - 1] = lane;
      halfWidths[points.length - 1] = halfWidth;
    };
    const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1];
    const lead = Math.min(18, Math.hypot(dx, dy) / 4);
    const start = a.tangent ? [a.p[0] + a.tangent[0] * lead, a.p[1] + a.tangent[1] * lead] : a.p;
    const end = b.tangent ? [b.p[0] - b.tangent[0] * lead, b.p[1] - b.tangent[1] * lead] : b.p;
    add(start);
    const horizontal = a.tangent ? Math.abs(a.tangent[0]) > 0.5 : Math.abs(dx) >= Math.abs(dy);
    const endHorizontal = b.tangent ? Math.abs(b.tangent[0]) > 0.5 : !horizontal;
    if (horizontal === endHorizontal) {
      const axis = horizontal ? 0 : 1;
      const travel = end[axis] - start[axis];
      const reverse = (a.tangent && travel * a.tangent[axis] <= 0) || (b.tangent && travel * b.tangent[axis] <= 0);
      if (reverse) {
        const startSign = a.tangent?.[axis] || Math.sign(travel) || 1;
        const endSign = b.tangent?.[axis] || Math.sign(travel) || 1;
        const fromCandidate = snap(start[axis] + startSign * (24 + Math.abs(lane))) + lane;
        const toCandidate = snap(end[axis] - endSign * (24 + Math.abs(lane))) + lane;
        let from = (fromCandidate - start[axis]) * startSign > 0 ? fromCandidate : start[axis] + startSign * 24;
        let to = (end[axis] - toCandidate) * endSign > 0 ? toCandidate : end[axis] - endSign * 24;
        if (Math.abs(from - to) < 1e-6) to -= endSign * 20;
        const middleNormal = (horizontal ? 1 : -1) * (Math.sign(to - from) || -startSign);
        let cross = snap(Math.max(start[1 - axis], end[1 - axis]) + 30 + 2 * Math.abs(lane)) + middleNormal * lane;
        let outside = null;
        if (horizontal) {
          const sourceBox = i === 1 ? seg.sourceBox : null;
          const targetBox = i === stops.length - 1 ? seg.targetBox : null;
          const boxes = [sourceBox, targetBox].filter(Boolean);
          if (boxes.length) {
            const top = Math.min(start[1], end[1], ...boxes.map((box) => box[1]));
            const bottom = Math.max(start[1], end[1], ...boxes.map((box) => box[1] + box[3]));
            const toward = b.p[1] - a.p[1];
            const up = toward < 0 || (toward === 0 && start[1] - top <= bottom - start[1]);
            const margin = 24 + Math.abs(lane);
            const gapStart = up ? targetBox && targetBox[1] + targetBox[3] : sourceBox && sourceBox[1] + sourceBox[3];
            const gapEnd = up ? sourceBox?.[1] : targetBox?.[1];
            const clearance = (canvas.connections_width ?? 3) / 2 + 2;
            const bundleHalf = Math.max(a.halfWidth ?? 0, b.halfWidth ?? 0);
            if (gapStart != null && gapEnd != null && gapEnd - gapStart > 2 * (clearance + bundleHalf)) {
              const middle = (gapStart + gapEnd) / 2 + middleNormal * lane;
              const snapped = snap((gapStart + gapEnd) / 2) + middleNormal * lane;
              cross = snapped > gapStart + clearance && snapped < gapEnd - clearance ? snapped : middle;
            } else {
              cross = snap((up ? top - margin : bottom + margin)) + middleNormal * lane;
              if (sourceBox && targetBox) {
                const left = Math.min(sourceBox[0], targetBox[0]);
                const right = Math.max(sourceBox[0] + sourceBox[2], targetBox[0] + targetBox[2]);
                outside = { left, right, margin };
              }
            }
          }
        }
        const sideNormal = horizontal ? -1 : 1;
        from += (sideNormal * Math.sign(cross - start[1 - axis]) - 1) * lane;
        to += (sideNormal * Math.sign(end[1 - axis] - cross) - 1) * lane;
        if (outside) {
          if (startSign > 0) from = Math.max(from, snap(outside.right + outside.margin) + lane);
          else from = Math.min(from, snap(outside.left - outside.margin) + lane);
          if (endSign > 0) to = Math.min(to, snap(outside.left - outside.margin) + lane);
          else to = Math.max(to, snap(outside.right + outside.margin) + lane);
        }
        if (Math.abs(from - to) < 1e-6) to -= endSign * 20;
        if (horizontal) {
          add([from, start[1]]);
          add([from, cross]);
          add([to, cross]);
          add([to, end[1]]);
        } else {
          add([start[0], from]);
          add([cross, from]);
          add([cross, to]);
          add([end[0], to]);
        }
      } else if (start[0] !== end[0] && start[1] !== end[1]) {
        const midpoint = (start[axis] + end[axis]) / 2;
        const middleNormal = horizontal ? -Math.sign(end[1] - start[1]) : Math.sign(end[0] - start[0]);
        const candidate = snap(midpoint) + middleNormal * lane;
        const mid = (candidate - start[axis]) * (end[axis] - candidate) > 0 ? candidate : midpoint;
        if (horizontal) {
          add([mid, start[1]]);
          add([mid, end[1]]);
        } else {
          add([start[0], mid]);
          add([end[0], mid]);
        }
      }
    } else {
      const firstAxis = horizontal ? 0 : 1;
      const lastAxis = 1 - firstAxis;
      const firstReverse = a.tangent && (end[firstAxis] - start[firstAxis]) * a.tangent[firstAxis] <= 0;
      const lastReverse = b.tangent && (end[lastAxis] - start[lastAxis]) * b.tangent[lastAxis] <= 0;
      if (firstReverse || lastReverse) {
        const firstSign = a.tangent?.[firstAxis] || 1;
        const lastSign = b.tangent?.[lastAxis] || 1;
        const firstCandidate = snap(start[firstAxis] + firstSign * (24 + Math.abs(lane))) + lane;
        const lastCandidate = snap(end[lastAxis] - lastSign * (24 + Math.abs(lane))) + lane;
        let first = (firstCandidate - start[firstAxis]) * firstSign > 0 ? firstCandidate : start[firstAxis] + firstSign * 24;
        let last = (end[lastAxis] - lastCandidate) * lastSign > 0 ? lastCandidate : end[lastAxis] - lastSign * 24;
        if (Math.abs(first - end[firstAxis]) < 1e-6) first += firstSign * 20;
        if (Math.abs(last - start[lastAxis]) < 1e-6) last -= lastSign * 20;
        if (horizontal) {
          add([first, start[1]]);
          add([first, last]);
          add([end[0], last]);
        } else {
          add([start[0], first]);
          add([last, first]);
          add([last, end[1]]);
        }
      } else if (start[0] !== end[0] && start[1] !== end[1]) add(horizontal ? [end[0], start[1]] : [start[0], end[1]]);
    }
    add(end);
    add(b.p);
  }
  return { points, lanes, halfWidths };
}

/** Trace the same quadratic corners for drawing and the Z-drag intersection test. */
function roundedGridPath(path, route) {
  const { points, lanes, halfWidths } = route;
  const polyline = [points[0]];
  path?.moveTo(...points[0]);
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1], cur = points[i], next = points[i + 1];
    const before = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const after = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
    const turn = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
    if (!turn || !before || !after) {
      path?.lineTo(...cur);
      polyline.push(cur);
      continue;
    }
    const radius = Math.min(12 + halfWidths[i] - Math.sign(turn) * lanes[i], before / 2, after / 2);
    const enter = [cur[0] - (cur[0] - prev[0]) * radius / before, cur[1] - (cur[1] - prev[1]) * radius / before];
    const leave = [cur[0] + (next[0] - cur[0]) * radius / after, cur[1] + (next[1] - cur[1]) * radius / after];
    path?.lineTo(...enter);
    path?.quadraticCurveTo(...cur, ...leave);
    polyline.push(enter);
    for (let j = 1; j <= 8; j++) {
      const t = j / 8, u = 1 - t;
      polyline.push([u * u * enter[0] + 2 * u * t * cur[0] + t * t * leave[0], u * u * enter[1] + 2 * u * t * cur[1] + t * t * leave[1]]);
    }
  }
  path?.lineTo(...points.at(-1));
  polyline.push(points.at(-1));
  return polyline;
}

function pointOnGrid(polyline, fraction) {
  let total = 0;
  for (let i = 1; i < polyline.length; i++) total += Math.hypot(polyline[i][0] - polyline[i - 1][0], polyline[i][1] - polyline[i - 1][1]);
  let remaining = total * fraction;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1], b = polyline[i];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= length || i === polyline.length - 1) {
      const t = length ? remaining / length : 0;
      return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t };
    }
    remaining -= length;
  }
  return { x: polyline[0][0], y: polyline[0][1] };
}

/** Polyline of one segment, matching the spline the link adapter draws. */
function segmentPolyline(canvas, seg) {
  const { a, b } = seg;
  if (canvas.links_render_mode !== undefined && canvas.links_render_mode !== 2) {
    // LINEAR (1) and STRAIGHT (0) links: a polyline through the endpoints is close enough for hit tests.
    return [a, b];
  }
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1]) * CONTROL_FACTOR;
  const c0 = seg.startControl ? [a[0] + seg.startControl[0], a[1] + seg.startControl[1]] : offsetByDir(a, seg.sd || DIR.RIGHT, dist);
  const c1 = seg.endControl ? [b[0] + seg.endControl[0], b[1] + seg.endControl[1]] : offsetByDir(b, seg.ed || DIR.LEFT, dist);
  const out = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    out.push([w0 * a[0] + w1 * c0[0] + w2 * c1[0] + w3 * b[0], w0 * a[1] + w1 * c0[1] + w2 * c1[1] + w3 * b[1]]);
  }
  return out;
}

/** Intersection parameter (along p→q) of segments p→q and r→s, or null. */
function intersect(p, q, r, s) {
  const d1x = q[0] - p[0], d1y = q[1] - p[1];
  const d2x = s[0] - r[0], d2y = s[1] - r[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const ex = r[0] - p[0], ey = r[1] - p[1];
  const t = (ex * d2y - ey * d2x) / den;
  const u = (ex * d1y - ey * d1x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

function tieBar(canvas, tie) {
  const h = tieHalfLength(canvas, tie);
  const { n } = tieAxes(tie);
  return [
    [tie.pos[0] - n[0] * h, tie.pos[1] - n[1] * h],
    [tie.pos[0] + n[0] * h, tie.pos[1] + n[1] * h],
  ];
}

function tieAt(canvas, graph, p) {
  if (linksHidden(canvas)) return null;
  const pad = HIT_PAD_PX / canvas.ds.scale;
  const ties = tiesOf(graph);
  for (let i = ties.length - 1; i >= 0; i--) {
    const tie = ties[i];
    if (!tieShown(tie)) continue;
    const { t, n } = tieAxes(tie);
    const dx = p[0] - tie.pos[0], dy = p[1] - tie.pos[1];
    const along = dx * t[0] + dy * t[1];
    const across = dx * n[0] + dy * n[1];
    if (Math.abs(along) <= BAR_HALF_WIDTH + pad && Math.abs(across) <= tieHalfLength(canvas, tie) + pad) return tie;
  }
  return null;
}

// ---------- strokes ----------

/** What a stroke from p to q would do: cut the ties it crosses, or else tie the wires it crosses. */
function strokeTargets(canvas, graph, p, q) {
  const ties = tiesOf(graph);
  const cutTies = ties.filter((tie) => {
    if (!tieShown(tie)) return false;
    const [r, s] = tieBar(canvas, tie);
    return intersect(p, q, r, s) !== null;
  });
  if (cutTies.length) return { cutTies, hits: [] };

  const hits = [];
  for (const [key, ep] of state.endpoints) {
    let best = null;
    const grid = setting(ROUTING_SETTING, "Default") === GRID_ROUTING;
    for (const seg of grid ? [ep] : route(canvas, key, ep)) {
      const poly = grid ? roundedGridPath(null, gridRoute(canvas, key, seg)) : segmentPolyline(canvas, seg);
      for (let i = 1; i < poly.length; i++) {
        const t = intersect(p, q, poly[i - 1], poly[i]);
        if (t === null || (best && t >= best.t)) continue;
        const dx = poly[i][0] - poly[i - 1][0], dy = poly[i][1] - poly[i - 1][1];
        const len = Math.hypot(dx, dy) || 1;
        best = { t, key, tangent: [dx / len, dy / len] };
      }
    }
    if (best) hits.push(best);
  }
  return { cutTies, hits };
}

function applyStroke(canvas, graph, p, q) {
  if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 4 / canvas.ds.scale) return;
  const { cutTies, hits } = strokeTargets(canvas, graph, p, q);

  if (cutTies.length) {
    graph.extra[EXTRA_KEY] = tiesOf(graph).filter((t) => !cutTies.includes(t));
    syncTies(graph);
    commit(canvas);
    return;
  }
  if (!hits.length) return;

  const point = (h) => [p[0] + (q[0] - p[0]) * h.t, p[1] + (q[1] - p[1]) * h.t];
  let tx = 0, ty = 0, cx = 0, cy = 0;
  for (const h of hits) {
    tx += h.tangent[0];
    ty += h.tangent[1];
    const pt = point(h);
    cx += pt[0];
    cy += pt[1];
  }
  const angle = Math.hypot(tx, ty) > 1e-6 ? Math.atan2(ty, tx) : 0;
  const n = [-Math.sin(angle), Math.cos(angle)];
  const pos = [cx / hits.length, cy / hits.length];
  hits.sort((h1, h2) => {
    const a = point(h1), b = point(h2);
    return (a[0] - b[0]) * n[0] + (a[1] - b[1]) * n[1];
  });

  // Keep the ribbon straight between ties: if an existing tie holds every new wire,
  // reuse its strand order so the wires cross outside the bundle, not inside it.
  const keys = hits.map((h) => h.key);
  const twin = tiesOf(graph).find((t) => keys.every((k) => t.links.includes(k)));
  if (twin) hits.sort((h1, h2) => twin.links.indexOf(h1.key) - twin.links.indexOf(h2.key));

  const all = tiesOf(graph, true);
  const tie = { id: nextTieId(all), pos, angle, links: hits.map((h) => h.key) };
  const color = newTieColor(all);
  if (color) tie.color = color;
  all.push(tie);
  syncTies(graph);
  commit(canvas);
}

function updatePreview(canvas) {
  state.previewFrame = 0;
  const cut = state.cut;
  if (!cut?.last || !canvas.graph) return;
  const { cutTies, hits } = strokeTargets(canvas, canvas.graph, cut.start, cut.last);
  state.preview = { keys: new Set(hits.map((h) => h.key)), cutTies: new Set(cutTies) };
  styleCutLine(cutTies.length ? "cut" : hits.length ? "tie" : "idle");
  canvas.setDirty(true, true);
}

function schedulePreview(canvas) {
  if (!state.previewFrame) state.previewFrame = requestAnimationFrame(() => updatePreview(canvas));
}

function endStroke(canvas) {
  if (state.previewFrame) cancelAnimationFrame(state.previewFrame);
  state.previewFrame = 0;
  state.cut = null;
  state.preview = null;
  hideCutLine();
  canvas.setDirty(true, true);
}

// ---------- tie menu ----------

function removeTie(canvas, graph, tie) {
  graph.extra[EXTRA_KEY] = tiesOf(graph).filter((t) => t !== tie);
  syncTies(graph);
  state.hovered = null;
  commit(canvas);
}

/** Litegraph's menu sanitises inline styles in item HTML, so swatches are added to the DOM after it opens. */
function addSwatches() {
  const colors = new Map([...PALETTE, ["Grey", GREY]]);
  for (const entry of document.querySelectorAll(".litecontextmenu .litemenu-entry")) {
    const color = colors.get(entry.textContent);
    if (!color || entry.dataset.zipTieSwatch) continue;
    entry.dataset.zipTieSwatch = "1";
    const dot = document.createElement("span");
    Object.assign(dot.style, {
      display: "inline-block",
      width: "10px",
      height: "10px",
      marginRight: "8px",
      borderRadius: "2px",
      verticalAlign: "-1px",
      background: color,
      boxShadow: "0 0 0 1px rgba(255,255,255,0.3)",
    });
    entry.prepend(dot);
  }
}

function showTieMenu(canvas, graph, tie, event) {
  const ContextMenu = window.LiteGraph?.ContextMenu;
  if (!ContextMenu) return;
  const recolor = (color) => () => {
    if (color) tie.color = color;
    else delete tie.color;
    commit(canvas);
  };
  const rotate = (by) => () => {
    tie.angle = (tie.angle ?? 0) + by;
    commit(canvas);
  };
  const colors = [
    ...PALETTE.map(([name, c]) => ({ content: name, callback: recolor(c) })),
    null,
    { content: "Match wires", callback: recolor(WIRES) },
    { content: "Grey", callback: recolor(undefined) },
  ];
  new ContextMenu(
    [
      { content: "Colour", has_submenu: true, submenu: { options: colors }, callback: () => void requestAnimationFrame(addSwatches) },
      { content: "Rotate 90°", callback: rotate(Math.PI / 2) },
      { content: "Rotate 45°", callback: rotate(Math.PI / 4) },
      null,
      { content: "Remove tie", callback: () => removeTie(canvas, graph, tie) },
    ],
    { event, title: "Zip tie" },
  );
}

function setArmed(canvas, armed) {
  state.armed = armed;
  canvas.canvas.style.cursor = armed ? "crosshair" : "";
}

// ---------- overlay for the stroke line ----------

function overlay() {
  if (state.overlay) return state.overlay;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;display:none";
  const line = document.createElementNS(svgNS, "line");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linecap", "round");
  svg.appendChild(line);
  document.body.appendChild(svg);
  state.overlay = { svg, line };
  return state.overlay;
}

/** "idle": crosses nothing yet, "tie": would tie wires, "cut": would remove a tie. */
function styleCutLine(mode) {
  const { line } = overlay();
  line.setAttribute("stroke", mode === "cut" ? CUT_RED : mode === "tie" ? PREVIEW_WHITE : "rgba(255,255,255,0.5)");
  if (mode === "idle") line.setAttribute("stroke-dasharray", "6 5");
  else line.removeAttribute("stroke-dasharray");
}

function showCutLine(x1, y1, x2, y2) {
  const { svg, line } = overlay();
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  svg.style.display = "block";
}

function hideCutLine() {
  if (state.overlay) state.overlay.svg.style.display = "none";
}

// ---------- input ----------

function graphPoint(canvas, e) {
  const rect = canvas.canvas.getBoundingClientRect();
  return canvas.ds.convertCanvasToOffset([e.clientX - rect.left, e.clientY - rect.top]);
}

function isTyping(e) {
  const el = e.target;
  return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function hasModifier(e) {
  return e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
}

function setHovered(canvas, id) {
  if (state.hovered === id) return;
  state.hovered = id;
  canvas.setDirty(true, true);
}

function pointerAngle(tie, p) {
  return Math.atan2(p[1] - tie.pos[1], p[0] - tie.pos[0]);
}

function installInput(canvas) {
  const el = canvas.canvas;

  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape" && state.armed) setArmed(canvas, false);
    if (e.code === tieKeyCode() && !hasModifier(e) && !isTyping(e)) state.keyHeld = true;
    // With only ties selected ComfyUI has nothing to delete, so the extension handles the key itself.
    const deleting = e.key === "Delete" || e.key === "Backspace";
    if (deleting && state.selected.size && !isTyping(e) && canvas.graph && !canvas.selectedItems?.size) {
      e.preventDefault();
      e.stopImmediatePropagation();
      removeTies(canvas, canvas.graph, new Set(state.selected));
      commit(canvas);
    }
  }, true);
  window.addEventListener("keyup", (e) => {
    if (e.code === tieKeyCode()) state.keyHeld = false;
  }, true);
  window.addEventListener("blur", () => {
    state.keyHeld = false;
    state.pointerDown = false;
  });

  // Right-click on a tie opens its menu instead of the canvas menu.
  const tieUnder = (e) => e.target === el && canvas.graph && tieAt(canvas, canvas.graph, graphPoint(canvas, e));
  window.addEventListener("contextmenu", (e) => {
    if (!tieUnder(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  window.addEventListener("pointerdown", (e) => {
    state.pointerDown = true;
    if (e.target !== el || !canvas.graph) return;
    const graph = canvas.graph;
    const p = graphPoint(canvas, e);

    if (e.button === 2) {
      const tie = tieAt(canvas, graph, p);
      if (!tie) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      showTieMenu(canvas, graph, tie, e);
      return;
    }
    if (e.button !== 0) return;

    // A held key only starts a stroke without modifiers, so Alt-drag cloning and similar keep working.
    const stroke = state.armed || (state.keyHeld && !hasModifier(e));
    if (stroke && !linksHidden(canvas)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (state.armed) setArmed(canvas, false);
      state.cut = { start: p, client: [e.clientX, e.clientY], pointerId: e.pointerId, last: null };
      state.preview = { keys: new Set(), cutTies: new Set() };
      styleCutLine("idle");
      showCutLine(e.clientX, e.clientY, e.clientX, e.clientY);
      return;
    }

    const tie = tieAt(canvas, graph, p);
    if (!tie) return;
    e.preventDefault();
    e.stopImmediatePropagation();

    const now = performance.now();
    if (state.lastDown.id === tie.id && now - state.lastDown.time < DOUBLE_CLICK_MS) {
      state.lastDown = { id: null, time: 0 };
      state.selected.delete(tie);
      removeTie(canvas, graph, tie);
      return;
    }
    state.lastDown = { id: tie.id, time: now };

    // Ctrl/Cmd-click toggles a tie in the selection. Shift-click adds it; Shift-drag still rotates.
    if (e.ctrlKey || e.metaKey) {
      if (state.selected.has(tie)) state.selected.delete(tie);
      else state.selected.add(tie);
      canvas.setDirty(true, true);
      return;
    }
    if (!e.shiftKey && !state.selected.has(tie)) {
      canvas.deselectAll();
      state.selected.add(tie);
    }
    state.drag = {
      tie,
      last: p,
      pointerId: e.pointerId,
      moved: false,
      rotate: e.shiftKey,
      offset: (tie.angle ?? 0) - pointerAngle(tie, p),
    };
    el.style.cursor = "grabbing";
  }, true);

  window.addEventListener("pointermove", (e) => {
    if (state.cut && e.pointerId === state.cut.pointerId) {
      e.stopImmediatePropagation();
      showCutLine(state.cut.client[0], state.cut.client[1], e.clientX, e.clientY);
      state.cut.last = graphPoint(canvas, e);
      schedulePreview(canvas);
      return;
    }
    if (state.drag && e.pointerId === state.drag.pointerId) {
      e.stopImmediatePropagation();
      const { drag } = state;
      const p = graphPoint(canvas, e);
      if (drag.rotate) {
        // Shift-drag rotates about the tie centre, in 15° steps unless Alt is held too.
        let angle = pointerAngle(drag.tie, p) + drag.offset;
        if (!e.altKey) angle = Math.round(angle / SNAP) * SNAP;
        drag.tie.angle = angle;
      } else {
        // Dragging a selected tie moves every selected tie.
        const d = [p[0] - drag.last[0], p[1] - drag.last[1]];
        const group = state.selected.has(drag.tie) ? state.selected : new Set([drag.tie]);
        for (const tie of group) shiftTie(tie, d);
        drag.last = p;
      }
      drag.moved = true;
      canvas.setDirty(true, true);
      return;
    }
    if (e.target !== el || !canvas.graph || e.buttons) return;
    const tie = tieAt(canvas, canvas.graph, graphPoint(canvas, e));
    setHovered(canvas, tie?.id ?? null);
    if (tie || state.armed) {
      // Litegraph sets the cursor while handling the move; set ours afterwards.
      requestAnimationFrame(() => (el.style.cursor = tie ? "grab" : "crosshair"));
    }
  }, true);

  const end = (e) => {
    state.pointerDown = false;
    state.liveSelectBase = null;
    if (state.cut && e.pointerId === state.cut.pointerId) {
      e.stopImmediatePropagation();
      const start = state.cut.start;
      endStroke(canvas);
      if (e.type === "pointerup" && canvas.graph) applyStroke(canvas, canvas.graph, start, graphPoint(canvas, e));
      return;
    }
    if (state.drag && e.pointerId === state.drag.pointerId) {
      e.stopImmediatePropagation();
      const { moved, rotate, tie } = state.drag;
      state.drag = null;
      el.style.cursor = "";
      if (rotate && !moved) state.selected.add(tie);
      else if (!moved && state.selected.size > 1) {
        // A plain click on one of several selected ties selects just that tie.
        canvas.deselectAll();
        state.selected.add(tie);
      }
      if (moved) commit(canvas);
      else canvas.setDirty(true, true);
    }
  };
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
}

// ---------- copy and paste ----------

function anchorOf(graph, key) {
  const anchor = anchorsOf(graph, key).find((a) => a[0] === "n") ?? anchorsOf(graph, key)[0];
  if (!anchor) return null;
  const pos = anchorPosition(graph, anchor);
  return pos ? { key: anchor, pos } : null;
}

/** Ties whose every member is in the copied items travel with them, under the clipboard's "zipTies" key. */
function copiedTies(graph, items) {
  const links = new Set((items.links ?? []).map((l) => l.id));
  const reroutes = new Set((items.reroutes ?? []).map((r) => r.id));
  const out = [];
  for (const tie of tiesOf(graph)) {
    const inside = tie.links.every((k) => (isRerouteKey(k) ? reroutes.has(rerouteIdOf(k)) : links.has(k)));
    const anchor = inside ? anchorOf(graph, tie.links[0]) : null;
    if (anchor) out.push({ pos: [...tie.pos], angle: tie.angle, color: tie.color, links: [...tie.links], anchor });
  }
  return out;
}

function pastedAnchorPos(result, anchor) {
  const id = anchor.key.slice(1);
  if (anchor.key[0] === "r") return result.reroutes?.get(Number(id))?.pos;
  return (result.nodes?.get(Number(id)) ?? result.nodes?.get(id))?.pos;
}

function addPastedTies(graph, copied, result) {
  const all = tiesOf(graph, true);
  for (const tie of copied) {
    const links = tie.links
      .map((k) => (isRerouteKey(k) ? (result.reroutes?.get(rerouteIdOf(k)) ? rerouteKey(result.reroutes.get(rerouteIdOf(k)).id) : null) : result.links?.get(k)?.id))
      .filter((k) => k != null);
    const now = pastedAnchorPos(result, tie.anchor);
    if (!links.length || !now) continue;
    const pasted = { id: nextTieId(all), pos: [tie.pos[0] + now[0] - tie.anchor.pos[0], tie.pos[1] + now[1] - tie.anchor.pos[1]], angle: tie.angle, links };
    if (tie.color) pasted.color = tie.color;
    all.push(pasted);
  }
  syncTies(graph);
}

function installClipboard(canvas) {
  const proto = Object.getPrototypeOf(canvas);
  const origSerialize = proto._serializeItems;
  const origDeserialize = proto._deserializeItems;
  if (!origSerialize || !origDeserialize) return;

  proto._serializeItems = function (...args) {
    const items = origSerialize.apply(this, args);
    if (this.graph && items) {
      const ties = copiedTies(this.graph, items);
      if (ties.length) items[CLIPBOARD_KEY] = ties;
    }
    return items;
  };

  proto._deserializeItems = function (clipboardItems, ...rest) {
    const copied = clipboardItems?.[CLIPBOARD_KEY];
    const graph = this.graph;
    if (!Array.isArray(copied) || !copied.length || !graph) return origDeserialize.call(this, clipboardItems, ...rest);
    // One change for the paste and its ties, so a single undo removes both.
    graph.beforeChange?.();
    this.emitBeforeChange?.();
    try {
      const result = origDeserialize.call(this, clipboardItems, ...rest);
      if (result) addPastedTies(graph, copied, result);
      return result;
    } finally {
      graph.afterChange?.();
      this.emitAfterChange?.();
    }
  };
}

// ---------- rendering ----------

function wireColor(tie) {
  const counts = new Map();
  let best = GREY;
  let max = 0;
  for (const key of tie.links) {
    const c = state.linkColors.get(key);
    if (!c) continue;
    const n = (counts.get(c) ?? 0) + 1;
    counts.set(c, n);
    if (n > max) {
      max = n;
      best = c;
    }
  }
  return best;
}

function tieColor(tie) {
  if (tie.color === WIRES) return wireColor(tie);
  return tie.color || GREY;
}

function drawTies(canvas, ctx, graph) {
  const ties = tiesOf(graph);
  if (!ties.length) return;
  ctx.save();
  for (const tie of ties) {
    if (!tieShown(tie)) continue;
    const cutting = state.preview?.cutTies.has(tie);
    const active = tie.id === state.hovered || state.drag?.tie === tie;
    const selected = state.selected.has(tie);
    const h = tieHalfLength(canvas, tie);
    ctx.save();
    ctx.translate(tie.pos[0], tie.pos[1]);
    ctx.rotate(tieAngle(tie));
    ctx.fillStyle = tieColor(tie);
    ctx.strokeStyle = cutting ? CUT_RED : selected || active ? "#ffffff" : "rgba(0,0,0,0.6)";
    ctx.lineWidth = cutting || selected ? 2 : active ? 1.5 : 1;
    // Strap across the wires, with the locking head at one end.
    ctx.beginPath();
    ctx.roundRect(-BAR_HALF_WIDTH, -h, BAR_HALF_WIDTH * 2, h * 2, BAR_HALF_WIDTH);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(-HEAD_HALF_WIDTH, -h - HEAD_LENGTH + 1, HEAD_HALF_WIDTH * 2, HEAD_LENGTH, 1.5);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

/** Member key of the segment renderLink is drawing, or null for segments ties never hold. */
function segmentKey(link, opts) {
  if (opts.reroute) return rerouteKey(opts.reroute.id);
  if (opts.endControl) return null; // a reroute segment drawn without its reroute (link badge entry)
  return link.id;
}

function tieVisible(canvas, tie) {
  const area = canvas.visible_area;
  if (!area) return true;
  const m = 40 / canvas.ds.scale;
  return tie.pos[0] >= area[0] - m && tie.pos[0] <= area[0] + area[2] + m && tie.pos[1] >= area[1] - m && tie.pos[1] <= area[1] + area[3] + m;
}

function renderGridLink(canvas, original, ctx, seg, link, skipBorder, flow, color, opts) {
  const linkRenderer = canvas.linkRenderer;
  const renderer = linkRenderer.pathRenderer;
  const route = gridRoute(canvas, segmentKey(link, opts), seg);
  const { points } = route;
  const polyline = roundedGridPath(null, route);
  const drawLinkPath = renderer.drawLinkPath;
  const calculateCenterPoint = renderer.calculateCenterPoint;
  const computeConnectionPoint = renderer.computeConnectionPoint;
  const calculateLinkBounds = linkRenderer.calculateLinkBounds;
  renderer.drawLinkPath = function (ctx, path, link, context, width, stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    roundedGridPath(path, route);
    ctx.stroke(path);
  };
  renderer.calculateCenterPoint = function (link) {
    link.centerPos = pointOnGrid(polyline, 0.5);
    const after = pointOnGrid(polyline, 0.51);
    link.centerAngle = Math.atan2(after.y - link.centerPos.y, after.x - link.centerPos.x);
  };
  renderer.computeConnectionPoint = function (_link, t) {
    return pointOnGrid(polyline, t);
  };
  linkRenderer.calculateLinkBounds = function () {
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    return { x: minX - 20, y: minY - 20, width: maxX - minX + 40, height: maxY - minY + 40 };
  };
  try {
    return original.call(canvas, ctx, seg.a, seg.b, link, skipBorder, flow, color, seg.sd, seg.ed, opts);
  } finally {
    renderer.drawLinkPath = drawLinkPath;
    renderer.calculateCenterPoint = calculateCenterPoint;
    renderer.computeConnectionPoint = computeConnectionPoint;
    linkRenderer.calculateLinkBounds = calculateLinkBounds;
  }
}

function installRendering(canvas) {
  const proto = Object.getPrototypeOf(canvas);
  const origRenderLink = proto.renderLink;
  const origDrawConnections = proto.drawConnections;
  const origRenderAllSegments = proto._renderAllLinkSegments;

  proto.renderLink = function (ctx, a, b, link, skipBorder, flow, color, sd, ed, opts = {}) {
    if (state.rendering || !link || this.graph !== canvas.graph) return origRenderLink.apply(this, arguments);
    state.rendered = true;
    const key = segmentKey(link, opts);
    const seg = { a: [a[0], a[1]], b: [b[0], b[1]], sd, ed, startControl: opts.startControl, endControl: opts.endControl };
    if (setting(ROUTING_SETTING, "Default") === GRID_ROUTING) {
      if (sd !== DIR.CENTER && !opts.startControl) {
        const bounds = endpointNode(this.graph, link.origin_id)?.boundingRect;
        if (bounds) seg.sourceBox = [...bounds];
      }
      if (ed !== DIR.CENTER && !opts.reroute) {
        const bounds = endpointNode(this.graph, link.target_id)?.boundingRect;
        if (bounds) seg.targetBox = [...bounds];
      }
    }
    if (key != null) state.endpoints.set(key, seg);
    const previewed = state.preview?.keys.has(key);
    const ties = state.index.get(key);
    if (setting(ROUTING_SETTING, "Default") === GRID_ROUTING) {
      if (ties?.length) state.linkColors.set(key, color || link.color || this.constructor.link_type_colors?.[link.type] || this.default_link_color);
      const active = previewed || ties?.some((t) => t.id === state.hovered || state.drag?.tie === t);
      return renderGridLink(this, origRenderLink, ctx, seg, link, skipBorder, flow, color ?? (active ? PREVIEW_WHITE : null), opts);
    }
    if (key == null) return origRenderLink.apply(this, arguments);
    if (!ties?.length) {
      if (!previewed) return origRenderLink.apply(this, arguments);
      return origRenderLink.call(this, ctx, a, b, link, skipBorder, flow, PREVIEW_WHITE, sd, ed, opts);
    }
    state.linkColors.set(key, color || link.color || this.constructor.link_type_colors?.[link.type] || this.default_link_color);

    const active = previewed || ties.some((t) => t.id === state.hovered || state.drag?.tie === t);
    const segColor = color ?? (active ? PREVIEW_WHITE : null);
    const segs = route(this, key, seg);
    const marker = this.linkMarkerShape;
    state.rendering = true;
    try {
      // Draw every sub-segment after the first without a centre marker, then the first one
      // last so the link's hit path and centre marker belong to the output-side piece.
      this.linkMarkerShape = MARKER_NONE;
      for (let i = 1; i < segs.length; i++) {
        const s = segs[i];
        origRenderLink.call(this, ctx, s.a, s.b, link, skipBorder, flow, segColor, s.sd, s.ed, { ...opts, startControl: s.startControl, endControl: s.endControl });
      }
      this.linkMarkerShape = marker;
      const s = segs[0];
      origRenderLink.call(this, ctx, s.a, s.b, link, skipBorder, flow, segColor, s.sd, s.ed, { ...opts, startControl: s.startControl, endControl: s.endControl });
    } finally {
      this.linkMarkerShape = marker;
      state.rendering = false;
    }
  };

  if (origRenderAllSegments) {
    // Litegraph skips a link whose ends are both off screen, which would hide a ribbon dragged into view.
    proto._renderAllLinkSegments = function (ctx, link, startPos, endPos, visibleReroutes, renderedSegments, now, startDir, endDir, ...rest) {
      state.rendered = false;
      const r = origRenderAllSegments.apply(this, arguments);
      if (state.rendered || this !== canvas || !link || link.parentId != null || link._dragging) return r;
      const ties = state.index.get(link.id);
      if (ties?.some((t) => tieVisible(this, t))) {
        this.renderLink(ctx, startPos, endPos, link, false, 0, null, startDir || DIR.RIGHT, endDir || DIR.LEFT);
      }
      return r;
    };
  }

  proto.drawConnections = function (ctx, ...rest) {
    const graph = this.graph;
    if (this !== canvas || !graph) return origDrawConnections.call(this, ctx, ...rest);
    state.endpoints.clear();
    state.tieDirection.clear();
    state.linkColors.clear();
    syncTies(graph);
    followMoves(this, graph);
    const r = origDrawConnections.call(this, ctx, ...rest);
    if (!linksHidden(this)) drawTies(this, ctx, graph);
    return r;
  };
}

app.registerExtension({
  name: "safzan.ZipTies",
  settings: [
    {
      id: COLOR_SETTING,
      category: ["Zip Ties", "Ties", "New tie colour"],
      name: "Colour of new ties",
      tooltip: "Random picks a cable-tie colour for each new tie. Match wires takes the colour of the wires it holds. Right-click a tie to change its colour.",
      type: "combo",
      options: Object.values(COLOR_MODE),
      defaultValue: COLOR_MODE.RANDOM,
    },
    {
      id: KEY_SETTING,
      category: ["Zip Ties", "Ties", "Key"],
      name: "Key to hold while dragging across wires",
      tooltip: "Hold this key and drag a line across wires to tie them, or across a tie to remove it. Only keys ComfyUI does not use on their own are offered.",
      type: "combo",
      options: KEYS,
      defaultValue: "Z",
    },
    {
      id: ROUTING_SETTING,
      category: ["Zip Ties", "Wires", "Routing"],
      name: "Wire routing",
      tooltip: "Draw all wires along horizontal and vertical runs with rounded corners. Ties use the nearest right angle while this mode is on.",
      type: "combo",
      options: ["Default", GRID_ROUTING],
      defaultValue: "Default",
      onChange: () => app.canvas?.setDirty(true, true),
    },
  ],
  getCanvasMenuItems() {
    const canvas = app.canvas;
    if (!canvas || linksHidden(canvas)) return [];
    return [
      null,
      {
        content: "Tie wires",
        callback: () => setArmed(canvas, true),
      },
    ];
  },
  async setup() {
    const canvas = app.canvas;
    installRendering(canvas);
    installClipboard(canvas);
    installInput(canvas);
    installSelection(canvas);
  },
});
