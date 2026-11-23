/** @import {ScreenView} from "../../../src/shared/protocol.ts" */

/** @param {ScreenView} view */
export function stateOf(view) {
  return view.state;
}

/** @type {ScreenView["state"]} */
export const first = "waiting";
