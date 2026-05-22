const playerEls = {
  playBtn: null,
  compareSeg: null,
  compareButtons: [],
  compareReadouts: [],
  autokeyPill: null,
  loopPill: null,
  durationInput: null,
  timeReadout: null,
  propertyList: null,
  laneHost: null,
  timeRuler: null,
  playhead: null,
  emptyState: null,
  timelinePane: null,
  timelineBody: null,
  panelToggle: null,
  viewButtons: [],
  zoomReadout: null,
  playerCard: null,
  moreBtn: null,
};

let playerRootId = "playerCard";

export function initPlayerElements(deps = {}) {
  playerRootId = deps.rootId ?? "playerCard";
}

export function getPlayerEls() {
  return playerEls;
}

export function cachePlayerEls() {
  const root = document.getElementById(playerRootId);
  playerEls.playerCard = root;
  if (!root) return;
  playerEls.playBtn = root.querySelector('[data-action="toggle-play"]');
  playerEls.autokeyPill = root.querySelector('[data-action="toggle-autokey"]');
  playerEls.loopPill = root.querySelector('[data-action="toggle-loop"]');
  playerEls.moreBtn = root.querySelector('[data-action="more"]');
  playerEls.durationInput = root.querySelector('[data-field="duration"]');
  playerEls.timeReadout = root.querySelector(".time-readout");
  playerEls.propertyList = root.querySelector(".property-list");
  playerEls.laneHost = root.querySelector(".lane-host");
  playerEls.timeRuler = root.querySelector(".time-ruler");
  playerEls.playhead = root.querySelector(".playhead-handle");
  playerEls.emptyState = root.querySelector(".empty-state");
  playerEls.timelinePane = root.querySelector(".timeline-pane");
  playerEls.timelineBody = root.querySelector(".timeline-pane-body");
  playerEls.panelToggle = root.querySelector('[data-action="toggle-timeline-panel"]');
  playerEls.viewButtons = Array.from(root.querySelectorAll("[data-timeline-view]"));
  playerEls.zoomReadout = root.querySelector("[data-timeline-zoom-readout]");

  playerEls.compareSeg = document.querySelector(".compare-mode");
  playerEls.compareButtons = playerEls.compareSeg
    ? Array.from(playerEls.compareSeg.querySelectorAll("button"))
    : [];
  playerEls.compareReadouts = Array.from(document.querySelectorAll('[data-stage-readout="compare"]'));
}
