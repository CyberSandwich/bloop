// Every modal dialog on the library page opens through library.js's sheet(), which lifts a toast into it so its Undo
// stays pressable; a dialog opened any other way leaves the toast inert under it.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../../public/js/", import.meta.url).pathname;
const files = ["library.js", ...readdirSync(`${dir}library`).map((name) => `library/${name}`)];

describe("library modal dialogs", () => {
  it("only sheet() in library.js calls showModal", () => {
    const callers = files.filter((file) => readFileSync(`${dir}${file}`, "utf8").includes(".showModal("));
    expect(callers).toEqual(["library.js"]);
  });

  it("sheet() lifts the toast after opening and again on close", () => {
    const source = readFileSync(`${dir}library.js`, "utf8");
    const sheet = source.slice(source.indexOf("async function sheet("), source.indexOf("/** A sheet's Close"));
    expect(sheet.match(/\blift\(\)/g)).toHaveLength(2);
  });
});
