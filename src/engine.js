// Fanuc 0i-MF G-code generation engine
// Pure functions: params in, array of G-code lines out.

// Module-scoped active decimal precision, set at the top of each generate() call based on
// the chosen unit system (Fanuc convention: 3 decimals for mm, 4 for inch). Safe as global
// state here because each generate() call runs synchronously start-to-finish with no
// reentrancy - there's no concurrent generation happening in this single-threaded UI.
let ACTIVE_DECIMALS = 3;

function fmt(n, decimals = ACTIVE_DECIMALS) {
  // Fanuc-style number formatting: trim trailing zeros, keep sign
  if (n === undefined || n === null || isNaN(n)) return "0";
  let s = n.toFixed(decimals);
  s = s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s;
}

// Guards every per-pass loop below against a zero, negative, blank, or NaN "depth per pass"
// value - without this, Math.ceil(depth / 0) is Infinity and the resulting for-loop never
// terminates, hanging (and eventually crashing) the whole app on nothing more than an empty
// form field. Also caps the pass count so an absurd depth/depthPerPass ratio (another easy
// typo) can't generate hundreds of thousands of G-code lines instead of erroring cleanly.
function safePassCount(depth, depthPerPass) {
  const dpp = Math.max(Number(depthPerPass) || 0, 0.001);
  const n = Math.ceil((Number(depth) || 0) / dpp);
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(n, 500);
}

function setActiveUnits(units) {
  ACTIVE_DECIMALS = units === "in" ? 4 : 3;
}

function header(p) {
  setActiveUnits(p.units);
  return [
    `%`,
    `O${String(p.programNumber).padStart(4, "0")} (${p.programName || "UNTITLED"})`,
    `(GENERATED - VERIFY BEFORE RUNNING ON MACHINE)`,
    `${p.units === "in" ? "G20" : "G21"} G17 G40 G49 G80 G90`,
    `G91 G28 Z0 (RETURN TO Z HOME BEFORE TOOL CHANGE)`,
    `G90`,
    `G${p.workOffset || 54}`,
    `T${p.toolNumber} M06`,
    `G43 H${p.toolNumber} Z${fmt(p.safetyZ)}`,
    `S${p.spindleSpeed} M03`,
    `M08`,
    `G00 X${fmt(p.startX ?? 0)} Y${fmt(p.startY ?? 0)}`,
  ];
}

function footer(p) {
  return [
    `G00 Z${fmt(p.retractZ ?? p.safetyZ)}`,
    `M09`,
    `G91 G28 Z0 (RETURN TO Z HOME)`,
    `G90`,
    `M05`,
    `M30`,
    `%`,
  ];
}

// ---- Rectangular pocket: linear ramp entry each pass + zigzag roughing + perimeter finish ----
function pocketGcode(p) {
  const lines = [...header(p)];
  const toolR = p.toolDiameter / 2;
  const stepover = Math.max(p.toolDiameter * (p.stepoverPct / 100), 0.01); // floor prevents a zero-advance infinite loop below
  const finishAllow = p.finishAllowance || 0;
  const rampAngle = p.rampAngleDeg || 3;

  const x0 = p.originX + toolR + finishAllow;
  const y0 = p.originY + toolR + finishAllow;
  const x1 = p.originX + p.width - toolR - finishAllow;
  const y1 = p.originY + p.height - toolR - finishAllow;

  const passes = safePassCount(p.depth, p.depthPerPass);

  lines.push(`(POCKET ${fmt(p.width)} X ${fmt(p.height)}, TOOL DIA ${fmt(p.toolDiameter)})`);
  lines.push(`(RAMP ENTRY AT ${fmt(rampAngle, 1)} DEG EACH PASS - SAFE FOR NON-CENTER-CUTTING TOOLS)`);

  for (let pass = 1; pass <= passes; pass++) {
    const zTarget = -Math.min(pass * p.depthPerPass, p.depth);
    const zPrev = pass === 1 ? 0 : -Math.min((pass - 1) * p.depthPerPass, p.depth);

    lines.push(`(ROUGH PASS ${pass} OF ${passes} - Z${fmt(zTarget)})`);
    lines.push(`G00 X${fmt(x0)} Y${fmt(y0)}`);
    lines.push(`G00 Z${fmt(zPrev)}`); // rapid down to previously-cleared depth (or stock top on pass 1) - never into solid

    // Linear ramp: traverse back and forth along the first row (x0<->x1) while descending,
    // instead of plunging straight down through this pass's depth increment.
    const rampLen = x1 - x0;
    const dropPerTraverse = Math.max(0.001, rampLen * Math.tan((rampAngle * Math.PI) / 180));
    const dropNeeded = zPrev - zTarget;
    const traverses = Math.max(1, Math.ceil(dropNeeded / dropPerTraverse));
    const dropEach = dropNeeded / traverses;

    let curZ = zPrev;
    let curX = x0;
    let rampGoingRight = true;
    for (let t = 0; t < traverses; t++) {
      curZ -= dropEach;
      if (t === traverses - 1) curZ = zTarget; // avoid float drift on the last step
      const targetX = rampGoingRight ? x1 : x0;
      lines.push(`G01 X${fmt(targetX)} Y${fmt(y0)} Z${fmt(curZ)} F${p.plungeFeed}`);
      curX = targetX;
      rampGoingRight = !rampGoingRight;
    }
    // guarantee the row ends at x1 at full depth before normal zigzag cutting continues
    if (Math.abs(curX - x1) > 0.0001) {
      lines.push(`G01 X${fmt(x1)} Y${fmt(y0)} F${p.feedRate}`);
    }

    // zigzag remaining rows across Y using stepover (row at y0 already cut by the ramp)
    lines.push(`F${p.feedRate}`);
    let y = y0 + stepover;
    let goingRight = false;
    while (y <= y1 + 0.0001) {
      const xTarget = goingRight ? x1 : x0;
      lines.push(`G01 X${fmt(xTarget)}`);
      const nextY = y + stepover;
      if (nextY <= y1 + 0.0001) {
        lines.push(`G01 Y${fmt(nextY)}`);
      }
      y = nextY;
      goingRight = !goingRight;
    }

    // retract between passes
    if (pass < passes) {
      lines.push(`G00 Z${fmt(p.retractZ)}`);
      lines.push(`G00 X${fmt(x0)} Y${fmt(y0)}`);
    }
  }

  // finish perimeter pass at full depth
  if (finishAllow > 0) {
    const fx0 = p.originX + toolR;
    const fy0 = p.originY + toolR;
    const fx1 = p.originX + p.width - toolR;
    const fy1 = p.originY + p.height - toolR;
    lines.push(`(FINISH PERIMETER PASS)`);
    lines.push(`G00 Z${fmt(p.retractZ)}`);
    lines.push(`G00 X${fmt(fx0)} Y${fmt(fy0)}`);
    lines.push(`G01 Z${fmt(-p.depth)} F${p.plungeFeed}`);
    lines.push(`F${p.finishFeed || p.feedRate}`);
    lines.push(`G01 X${fmt(fx1)}`);
    lines.push(`G01 Y${fmt(fy1)}`);
    lines.push(`G01 X${fmt(fx0)}`);
    lines.push(`G01 Y${fmt(fy0)}`);
  }

  lines.push(...footer(p));
  return lines;
}

// ---- Peck drilling cycle (G83) at one or more positions ----
function drillGcode(p) {
  const lines = [...header(p)];
  lines.push(`(PECK DRILL - DEPTH ${fmt(p.depth)}, PECK ${fmt(p.peckIncrement)})`);
  lines.push(`G00 Z${fmt(p.retractZ)}`);
  lines.push(
    `G83 X${fmt(p.startX ?? 0)} Y${fmt(p.startY ?? 0)} Z${fmt(-p.depth)} Q${fmt(
      p.peckIncrement
    )} R${fmt(p.rPlane)} F${p.feedRate}`
  );
  if (p.dwell) lines.push(`G04 P${p.dwell}`);
  lines.push(`G80`);
  lines.push(...footer(p));
  return lines;
}

// ---- Bolt hole circle: N holes evenly spaced, using G83 peck cycle ----
function boltCircleGcode(p) {
  const lines = [...header(p)];
  // Same guard rationale as safePassCount - a mistyped hole count (or a blank field
  // parsing to NaN) shouldn't be able to generate an unbounded number of lines.
  const holeCount = Math.min(Math.max(Math.round(Number(p.holeCount) || 0), 0), 360);
  lines.push(
    `(BOLT CIRCLE - ${holeCount} HOLES, RADIUS ${fmt(p.radius)}, DEPTH ${fmt(p.depth)})`
  );
  lines.push(`G00 Z${fmt(p.retractZ)}`);

  const positions = [];
  for (let i = 0; i < holeCount; i++) {
    const angleDeg = p.startAngle + (360 / holeCount) * i;
    const angleRad = (angleDeg * Math.PI) / 180;
    const x = p.centerX + p.radius * Math.cos(angleRad);
    const y = p.centerY + p.radius * Math.sin(angleRad);
    positions.push({ x, y });
  }

  positions.forEach((pos, i) => {
    if (i === 0) {
      lines.push(
        `G83 X${fmt(pos.x)} Y${fmt(pos.y)} Z${fmt(-p.depth)} Q${fmt(
          p.peckIncrement
        )} R${fmt(p.rPlane)} F${p.feedRate}`
      );
    } else {
      lines.push(`X${fmt(pos.x)} Y${fmt(pos.y)}`);
    }
  });

  lines.push(`G80`);
  lines.push(...footer(p));
  return lines;
}

// ---- Facing: open-sided zigzag across a rectangular area, overshooting the edges ----
function faceGcode(p) {
  const lines = [...header(p)];
  const toolR = p.toolDiameter / 2;
  const stepover = Math.max(p.toolDiameter * (p.stepoverPct / 100), 0.01); // floor prevents a zero-advance infinite loop below
  const overshoot = p.overshoot ?? toolR;

  const x0 = p.originX - overshoot;
  const x1 = p.originX + p.width + overshoot;
  const y0 = p.originY - toolR; // Y is the stepped axis, tool need only clear the edge
  const y1 = p.originY + p.height + toolR;

  const passes = safePassCount(p.depth, p.depthPerPass);

  lines.push(`(FACE ${fmt(p.width)} X ${fmt(p.height)}, TOOL DIA ${fmt(p.toolDiameter)})`);

  for (let pass = 1; pass <= passes; pass++) {
    const z = -Math.min(pass * p.depthPerPass, p.depth);
    lines.push(`(FACE PASS ${pass} OF ${passes} - Z${fmt(z)})`);
    lines.push(`G00 X${fmt(x0)} Y${fmt(y0)}`);
    lines.push(`G01 Z${fmt(z)} F${p.plungeFeed}`);
    lines.push(`F${p.feedRate}`);

    let y = y0;
    let goingRight = true;
    while (y <= y1 + 0.0001) {
      lines.push(`G01 X${fmt(goingRight ? x1 : x0)}`);
      const nextY = y + stepover;
      if (nextY <= y1 + 0.0001) {
        lines.push(`G01 Y${fmt(nextY)}`);
      } else if (y < y1 - 0.0001) {
        lines.push(`G01 Y${fmt(y1)}`); // final partial row to fully cover the area
      }
      y = nextY;
      goingRight = !goingRight;
    }

    if (pass < passes) {
      lines.push(`G00 Z${fmt(p.retractZ)}`);
      lines.push(`G00 X${fmt(x0)} Y${fmt(y0)}`);
    }
  }

  lines.push(...footer(p));
  return lines;
}

// ---- Circular pocket: straight plunge at center, then true spiral outward (short linear
// segments along an Archimedean spiral — avoids the radius-mismatch alarms that constant-
// radius G02/G03 arcs would risk if used to fake a spiral), then a full-circle finish pass ----
// ---- Circular pocket: true helical interpolation entry each pass (G02 with a Z move -
// standard Fanuc helical interpolation, universally supported, not the optional G12/G13
// pocket-milling cycle), then a true spiral outward, then a full-circle finish pass ----
function circularPocketGcode(p) {
  const lines = [...header(p)];
  const toolR = p.toolDiameter / 2;
  const stepover = Math.max(p.toolDiameter * (p.stepoverPct / 100), 0.01); // floor prevents a zero-advance infinite loop below
  const finishAllow = p.finishAllowance || 0;
  const roughMaxR = p.radius - toolR - finishAllow;
  const finishR = p.radius - toolR;
  const segmentDeg = p.spiralResolutionDeg || 15;
  const rampAngle = p.rampAngleDeg || 3;

  const passes = safePassCount(p.depth, p.depthPerPass);
  const entryR = Math.min(stepover, roughMaxR);

  lines.push(`(CIRCULAR POCKET R${fmt(p.radius)}, TOOL DIA ${fmt(p.toolDiameter)})`);
  lines.push(`(HELICAL ENTRY AT ${fmt(rampAngle, 1)} DEG, THEN SPIRAL ROUGH AT ${fmt(segmentDeg, 1)} DEG RESOLUTION)`);

  for (let pass = 1; pass <= passes; pass++) {
    const zTarget = -Math.min(pass * p.depthPerPass, p.depth);
    const zPrev = pass === 1 ? 0 : -Math.min((pass - 1) * p.depthPerPass, p.depth);
    lines.push(`(ROUGH PASS ${pass} OF ${passes} - Z${fmt(zTarget)})`);

    if (roughMaxR > 0) {
      // Position at the entry radius (rapid, above material - either stock top or
      // previously-cleared depth from the prior pass), then helical-plunge down to
      // this pass's target depth. Safe for non-center-cutting tools.
      lines.push(`G00 X${fmt(p.centerX + entryR)} Y${fmt(p.centerY)}`);
      lines.push(`G00 Z${fmt(zPrev)}`);
      const circumference = 2 * Math.PI * entryR;
      const pitchPerTurn = Math.max(0.001, circumference * Math.tan((rampAngle * Math.PI) / 180));
      const dropNeeded = zPrev - zTarget;
      const turns = Math.max(1, Math.ceil(dropNeeded / pitchPerTurn));
      const dropPerTurn = dropNeeded / turns;
      let curZ = zPrev;
      lines.push(`F${p.plungeFeed}`);
      for (let t = 0; t < turns; t++) {
        curZ -= dropPerTurn;
        if (t === turns - 1) curZ = zTarget;
        lines.push(`G02 X${fmt(p.centerX + entryR)} Y${fmt(p.centerY)} Z${fmt(curZ)} I${fmt(-entryR)} J0`);
      }

      // sweep straight through center to clear the plug the helix alone wouldn't reach
      lines.push(`F${p.feedRate}`);
      lines.push(`G01 X${fmt(p.centerX)} Y${fmt(p.centerY)}`);
      lines.push(`G01 X${fmt(p.centerX + entryR)} Y${fmt(p.centerY)}`);

      // continue the spiral outward from the entry radius (angle 360 = radius entryR,
      // consistent with the formula below, so there's no radius discontinuity)
      const totalAngleDeg = (roughMaxR / stepover) * 360;
      let lastX = p.centerX + entryR;
      let lastY = p.centerY;
      for (let angle = 360 + segmentDeg; angle <= totalAngleDeg + 0.0001; angle += segmentDeg) {
        const r = Math.min(stepover * (angle / 360), roughMaxR);
        const rad = (angle * Math.PI) / 180;
        lastX = p.centerX + r * Math.cos(rad);
        lastY = p.centerY + r * Math.sin(rad);
        lines.push(`G01 X${fmt(lastX)} Y${fmt(lastY)}`);
      }
      // close the loop with a full circle from wherever the spiral actually ended -
      // no extra chord move back to a fixed angle, which would cut a wasted line across the pocket
      lines.push(
        `G02 X${fmt(lastX)} Y${fmt(lastY)} I${fmt(p.centerX - lastX)} J${fmt(p.centerY - lastY)}`
      );
    } else {
      // pocket too small relative to tool + finish allowance to spiral at all - just plunge
      lines.push(`G00 X${fmt(p.centerX)} Y${fmt(p.centerY)}`);
      lines.push(`G01 Z${fmt(zTarget)} F${p.plungeFeed}`);
    }

    if (pass < passes) {
      lines.push(`G00 Z${fmt(p.retractZ)}`);
      lines.push(`G00 X${fmt(p.centerX)} Y${fmt(p.centerY)}`);
    }
  }

  if (finishAllow > 0) {
    lines.push(`(FINISH PASS)`);
    lines.push(`G00 Z${fmt(p.retractZ)}`);
    lines.push(`G00 X${fmt(p.centerX + finishR)} Y${fmt(p.centerY)}`);
    lines.push(`G01 Z${fmt(-p.depth)} F${p.plungeFeed}`);
    lines.push(`F${p.finishFeed || p.feedRate}`);
    lines.push(`G02 X${fmt(p.centerX + finishR)} Y${fmt(p.centerY)} I${fmt(-finishR)} J0`);
  }

  lines.push(...footer(p));
  return lines;
}

// ---- Profile / contour milling: follow an ordered list of XY points along the centerline ----
function profileGcode(p) {
  const lines = [...header(p)];
  const pts = p.points || [];
  if (pts.length < 2) {
    throw new Error("Profile needs at least 2 points");
  }
  const passes = safePassCount(p.depth, p.depthPerPass);
  const closed = p.closed;

  lines.push(`(PROFILE - ${pts.length} POINTS${closed ? ", CLOSED" : ""}, TOOL DIA ${fmt(p.toolDiameter)})`);
  lines.push(`(NOTE: CENTERLINE PATH - NO CUTTER COMP APPLIED. OFFSET POINTS BY TOOL RADIUS IF NEEDED.)`);

  for (let pass = 1; pass <= passes; pass++) {
    const z = -Math.min(pass * p.depthPerPass, p.depth);
    lines.push(`(PASS ${pass} OF ${passes} - Z${fmt(z)})`);
    lines.push(`G00 X${fmt(pts[0].x)} Y${fmt(pts[0].y)}`);
    lines.push(`G01 Z${fmt(z)} F${p.plungeFeed}`);
    lines.push(`F${pass === passes ? p.finishFeed || p.feedRate : p.feedRate}`);
    for (let i = 1; i < pts.length; i++) {
      lines.push(`G01 X${fmt(pts[i].x)} Y${fmt(pts[i].y)}`);
    }
    if (closed) {
      lines.push(`G01 X${fmt(pts[0].x)} Y${fmt(pts[0].y)}`);
    }
    if (pass < passes) {
      lines.push(`G00 Z${fmt(p.retractZ)}`);
    }
  }

  lines.push(...footer(p));
  return lines;
}

// Parses a textarea of "X,Y" lines (one point per line) into [{x,y}, ...]
function parsePoints(text) {
  return (text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(",").map((v) => parseFloat(v.trim()));
      return { x: parts[0], y: parts[1] };
    })
    .filter((pt) => !isNaN(pt.x) && !isNaN(pt.y));
}

const OPERATIONS = {
  pocket: {
    label: "Rectangular Pocket",
    generate: pocketGcode,
    fields: [
      { key: "originX", label: "Origin X", unit: "mm", default: 0, linear: true },
      { key: "originY", label: "Origin Y", unit: "mm", default: 0, linear: true },
      { key: "width", label: "Width (X)", unit: "mm", default: 40, linear: true, min: 0.01 },
      { key: "height", label: "Height (Y)", unit: "mm", default: 25, linear: true, min: 0.01 },
      { key: "depth", label: "Total Depth", unit: "mm", default: 5, linear: true, min: 0.001 },
      { key: "depthPerPass", label: "Depth / Pass", unit: "mm", default: 1.5, linear: true, min: 0.001 },
      { key: "toolDiameter", label: "Tool Diameter", unit: "mm", default: 8, linear: true, min: 0.01 },
      { key: "stepoverPct", label: "Stepover", unit: "%", default: 60, min: 1, max: 100 },
      { key: "rampAngleDeg", label: "Ramp Angle", unit: "deg", default: 3, min: 0.5, max: 45 },
      { key: "finishAllowance", label: "Finish Allowance", unit: "mm", default: 0.2, linear: true, min: 0 },
      { key: "feedRate", label: "Feed Rate", unit: "mm/min", default: 600, linear: true, min: 1 },
      { key: "finishFeed", label: "Finish Feed", unit: "mm/min", default: 400, linear: true, min: 1 },
      { key: "plungeFeed", label: "Plunge Feed", unit: "mm/min", default: 150, linear: true, min: 1 },
      { key: "retractZ", label: "Retract Plane Z", unit: "mm", default: 5, linear: true, min: 0.01 },
    ],
  },
  drill: {
    label: "Peck Drill (Single)",
    generate: drillGcode,
    fields: [
      { key: "startX", label: "Hole X", unit: "mm", default: 0, linear: true },
      { key: "startY", label: "Hole Y", unit: "mm", default: 0, linear: true },
      { key: "depth", label: "Depth", unit: "mm", default: 15, linear: true, min: 0.001 },
      { key: "peckIncrement", label: "Peck Increment", unit: "mm", default: 3, linear: true, min: 0.001 },
      { key: "rPlane", label: "R Plane", unit: "mm", default: 2, linear: true, min: 0.001 },
      { key: "retractZ", label: "Retract Plane Z", unit: "mm", default: 5, linear: true, min: 0.01 },
      { key: "feedRate", label: "Feed Rate", unit: "mm/min", default: 120, linear: true, min: 1 },
      { key: "dwell", label: "Dwell (optional)", unit: "sec", default: 0, min: 0 },
    ],
  },
  boltCircle: {
    label: "Bolt Hole Circle",
    generate: boltCircleGcode,
    fields: [
      { key: "centerX", label: "Center X", unit: "mm", default: 0, linear: true },
      { key: "centerY", label: "Center Y", unit: "mm", default: 0, linear: true },
      { key: "radius", label: "Radius", unit: "mm", default: 30, linear: true, min: 0.001 },
      { key: "holeCount", label: "Hole Count", unit: "", default: 6, min: 1, max: 360 },
      { key: "startAngle", label: "Start Angle", unit: "deg", default: 0 },
      { key: "depth", label: "Depth", unit: "mm", default: 10, linear: true, min: 0.001 },
      { key: "peckIncrement", label: "Peck Increment", unit: "mm", default: 3, linear: true, min: 0.001 },
      { key: "rPlane", label: "R Plane", unit: "mm", default: 2, linear: true, min: 0.001 },
      { key: "retractZ", label: "Retract Plane Z", unit: "mm", default: 5, linear: true, min: 0.01 },
      { key: "feedRate", label: "Feed Rate", unit: "mm/min", default: 120, linear: true, min: 1 },
    ],
  },
  face: {
    label: "Facing",
    generate: faceGcode,
    fields: [
      { key: "originX", label: "Origin X", unit: "mm", default: 0, linear: true },
      { key: "originY", label: "Origin Y", unit: "mm", default: 0, linear: true },
      { key: "width", label: "Width (X)", unit: "mm", default: 60, linear: true, min: 0.01 },
      { key: "height", label: "Height (Y)", unit: "mm", default: 40, linear: true, min: 0.01 },
      { key: "depth", label: "Total Depth", unit: "mm", default: 1, linear: true, min: 0.001 },
      { key: "depthPerPass", label: "Depth / Pass", unit: "mm", default: 0.5, linear: true, min: 0.001 },
      { key: "toolDiameter", label: "Tool Diameter", unit: "mm", default: 40, linear: true, min: 0.01 },
      { key: "stepoverPct", label: "Stepover", unit: "%", default: 70, min: 1, max: 100 },
      { key: "overshoot", label: "Edge Overshoot", unit: "mm", default: 5, linear: true, min: 0 },
      { key: "feedRate", label: "Feed Rate", unit: "mm/min", default: 800, linear: true, min: 1 },
      { key: "plungeFeed", label: "Plunge Feed", unit: "mm/min", default: 200, linear: true, min: 1 },
      { key: "retractZ", label: "Retract Plane Z", unit: "mm", default: 5, linear: true, min: 0.01 },
    ],
  },
  circularPocket: {
    label: "Circular Pocket",
    generate: circularPocketGcode,
    fields: [
      { key: "centerX", label: "Center X", unit: "mm", default: 0, linear: true },
      { key: "centerY", label: "Center Y", unit: "mm", default: 0, linear: true },
      { key: "radius", label: "Pocket Radius", unit: "mm", default: 20, linear: true, min: 0.001 },
      { key: "depth", label: "Total Depth", unit: "mm", default: 6, linear: true, min: 0.001 },
      { key: "depthPerPass", label: "Depth / Pass", unit: "mm", default: 1.5, linear: true, min: 0.001 },
      { key: "toolDiameter", label: "Tool Diameter", unit: "mm", default: 8, linear: true, min: 0.01 },
      { key: "stepoverPct", label: "Stepover", unit: "%", default: 60, min: 1, max: 100 },
      { key: "rampAngleDeg", label: "Helix Ramp Angle", unit: "deg", default: 3, min: 0.5, max: 45 },
      { key: "spiralResolutionDeg", label: "Spiral Segment Angle", unit: "deg", default: 15, min: 1, max: 90 },
      { key: "finishAllowance", label: "Finish Allowance", unit: "mm", default: 0.2, linear: true, min: 0 },
      { key: "feedRate", label: "Feed Rate", unit: "mm/min", default: 600, linear: true, min: 1 },
      { key: "finishFeed", label: "Finish Feed", unit: "mm/min", default: 400, linear: true, min: 1 },
      { key: "plungeFeed", label: "Plunge Feed", unit: "mm/min", default: 150, linear: true, min: 1 },
      { key: "retractZ", label: "Retract Plane Z", unit: "mm", default: 5, linear: true, min: 0.01 },
    ],
  },
  profile: {
    label: "Profile / Contour",
    generate: profileGcode,
    fields: [
      {
        key: "points",
        label: "Path Points (X,Y per line)",
        type: "points",
        default: "0,0\n40,0\n40,25\n0,25",
      },
      { key: "closed", label: "Closed Loop", type: "checkbox", default: true },
      { key: "depth", label: "Total Depth", unit: "mm", default: 5, linear: true, min: 0.001 },
      { key: "depthPerPass", label: "Depth / Pass", unit: "mm", default: 1.5, linear: true, min: 0.001 },
      { key: "toolDiameter", label: "Tool Diameter (reference only)", unit: "mm", default: 6, linear: true, min: 0.01 },
      { key: "feedRate", label: "Feed Rate", unit: "mm/min", default: 500, linear: true, min: 1 },
      { key: "finishFeed", label: "Finish Feed", unit: "mm/min", default: 350, linear: true, min: 1 },
      { key: "plungeFeed", label: "Plunge Feed", unit: "mm/min", default: 150, linear: true, min: 1 },
      { key: "retractZ", label: "Retract Plane Z", unit: "mm", default: 5, linear: true, min: 0.01 },
    ],
  },
};

const COMMON_FIELDS = [
  { key: "programNumber", label: "Program Number", unit: "", default: 1001, min: 1, max: 9999 },
  { key: "programName", label: "Program Name", unit: "", default: "PART1", isText: true },
  {
    key: "units",
    label: "Units",
    type: "select",
    options: [
      { value: "mm", label: "Metric (mm) - G21" },
      { value: "in", label: "Inch (in) - G20" },
    ],
    default: "mm",
  },
  { key: "toolNumber", label: "Tool Number", unit: "", default: 1, min: 1, max: 999 },
  { key: "spindleSpeed", label: "Spindle Speed", unit: "rpm", default: 3000, min: 1 },
  { key: "workOffset", label: "Work Offset (G5x)", unit: "", default: 54, min: 54, max: 59 },
  { key: "safetyZ", label: "Safety Plane Z", unit: "mm", default: 25, linear: true, min: 0.01 },
];
