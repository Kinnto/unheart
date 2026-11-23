export const DEFAULTS = Object.freeze({
  handle: null,
  confirmed: false,
  panel: { x: null, y: null, minimized: false },
  pillDismissed: false,
  progress: null,
  reviewAsked: false,
});

export function createStore(area = chrome.storage.local) {
  return {
    async get() {
      return { ...DEFAULTS, ...(await area.get(Object.keys(DEFAULTS))) };
    },
    set(patch) {
      return area.set(patch);
    },
  };
}
