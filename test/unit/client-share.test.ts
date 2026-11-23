import { describe, expect, it, vi } from "vitest";
import { mailtoFor, shareLink, shareText } from "../../public/js/core/share.js";

const page = { title: "bloop: your slides on any screen", url: "https://bloop.example/" };
const abort = () => Object.assign(new Error("closed"), { name: "AbortError" });

describe("Send Me the Link", () => {
  it("uses the share sheet with the design text when there is one", async () => {
    const share = vi.fn(async () => {});
    const copy = vi.fn(async () => {});
    const open = vi.fn();
    expect(await shareLink({ share, copy, open }, page)).toBe("shared");
    expect(share).toHaveBeenCalledWith({
      title: page.title,
      text: "Try bloop on a computer: https://bloop.example/",
      url: page.url,
    });
    expect(copy).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("does nothing more when the visitor closes the sheet", async () => {
    const copy = vi.fn(async () => {});
    const open = vi.fn();
    const share = vi.fn(async () => {
      throw abort();
    });
    expect(await shareLink({ share, copy, open }, page)).toBe("canceled");
    expect(copy).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("falls back to the clipboard when sharing fails or is missing", async () => {
    const copy = vi.fn(async () => {});
    const open = vi.fn();
    const share = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    expect(await shareLink({ share, copy, open }, page)).toBe("copied");
    expect(await shareLink({ share: undefined, copy, open }, page)).toBe("copied");
    expect(copy).toHaveBeenCalledWith(page.url);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a mail draft when neither works", async () => {
    const open = vi.fn();
    const copy = vi.fn(async () => {
      throw new Error("denied");
    });
    expect(await shareLink({ share: undefined, copy, open }, page)).toBe("mailto");
    expect(await shareLink({ share: undefined, copy: undefined, open }, page)).toBe("mailto");
    expect(open).toHaveBeenCalledWith("mailto:?subject=bloop&body=https%3A%2F%2Fbloop.example%2F");
  });

  it("formats the text and the draft", () => {
    expect(shareText("https://x.example/")).toBe("Try bloop on a computer: https://x.example/");
    expect(mailtoFor("https://x.example/?a=b&c")).toBe(
      "mailto:?subject=bloop&body=https%3A%2F%2Fx.example%2F%3Fa%3Db%26c",
    );
  });
});
