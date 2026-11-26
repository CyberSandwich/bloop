// Flips the dev server to open mode for the `open` project; restore.setup.ts puts it back.
import { setLaunchMode, test } from "./mode.ts";

test("the server launches in open mode", () => {
  setLaunchMode("open");
});
