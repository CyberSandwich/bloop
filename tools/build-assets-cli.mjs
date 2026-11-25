// `node tools/build-assets-cli.mjs [root]` builds `<root>/dist` (default: this repo). Its own file, so it always
// builds: a "run as main" check in the module fails when the path is reached through a symlink.
import { build } from "./build-assets.mjs";

const { written, deleted } = process.argv[2] ? build(process.argv[2]) : build();
console.log(`dist: ${written.length} written, ${deleted.length} deleted`);
