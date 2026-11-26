// The teardown of open.setup.ts: the dev server's state is preview again, as a reused local server expects.
import { setLaunchMode, test } from "./mode.ts";

test("the server launches in preview mode", () => {
  setLaunchMode("preview");
});
