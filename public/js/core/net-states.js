// The room screen's two network failures, loaded by the first one (screen.js shows copy-screen.js's plain line until
// then). The phone's own are in copy-phone.js.
/** @import {ScreenFacts} from "../types.js" */
import { down } from "../shared/errors.js";
import { BLOCKED } from "./copy.js";

/** @param {"service_down" | "network_blocked"} key @param {ScreenFacts} f */
export const screenNet = (key, f) =>
  key === "service_down"
    ? { heading: "bloop Isn't Responding", line: down("Refresh this page") }
    : { heading: BLOCKED, line: `Ask IT to allow ${f.host ?? "bloop"}, or try another network.` };
