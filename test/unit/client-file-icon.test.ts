import { describe, expect, it } from "vitest";
import { fileIcon } from "../../public/js/core/format.js";

describe("file row icon", () => {
  it("uses slides for decks and a document for PDFs", () => {
    const slides = fileIcon("Lecture 4.pptx");
    expect(fileIcon("Sample handout.pdf")).not.toEqual(slides);
    expect(fileIcon("NOTES.PDF")).toEqual(fileIcon("a.pdf"));
    expect(fileIcon("pdf.pptx")).toEqual(slides);
  });
});
