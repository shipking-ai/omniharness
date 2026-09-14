/**
 * A minimal observable store around the reducer.
 *
 * It lives outside React on purpose. Engine events arrive on a subscription
 * that has nothing to do with the render tree, and routing them through
 * component state was what scattered event handling across the old interface.
 * Here the runtime dispatches, the store reduces, and React reads the snapshot
 * through `useSyncExternalStore` — one direction, one source of truth.
 */

import { reduce } from './reducer.js';
import type { Action } from './actions.js';
import type { AppState } from './types.js';

export type Dispatch = (action: Action) => void;

export interface Store {
  getState(): AppState;
  dispatch: Dispatch;
  subscribe(listener: () => void): () => void;
}

export function createStore(initial: AppState): Store {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      // Reference equality is the signal: reducers that decline a no-op change
      // return the same object, and a needless notify is a needless repaint.
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
