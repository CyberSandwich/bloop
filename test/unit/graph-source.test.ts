// Contract tests: GraphFileSource against synthetic fixtures written from Microsoft's documentation
// (test/fixtures/graph/README.md). They check the requests it makes and how it maps every answer.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GraphFileSource, hostAllowed } from "../../src/worker/seams/file-source/graph.ts";
import type { SourceContext } from "../../src/worker/seams/file-source/index.ts";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/graph/${name}`, import.meta.url), "utf8");
const HOSTS = ["*.sharepoint.com", "*.files.1drv.com", "my.microsoftpersonalcontent.com"];

interface Call {
  url: URL;
  headers: Headers;
  redirect: RequestInit["redirect"];
}
type Answer = { status?: number; body?: string; headers?: Record<string, string> };

/** A fetch that answers by path and records every request. */
function graph(answer: (url: URL) => Answer) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
    const { status = 200, body = "", headers = {} } = answer(url);
    return new Response(status === 302 ? null : body, { status, headers });
  };
  return { source: new GraphFileSource({ fetch: fetcher, downloadHosts: HOSTS }), calls };
}

const ctx = (over: Partial<SourceContext> = {}): SourceContext => ({
  mode: "live",
  userId: "u1",
  folderId: null,
  accessToken: async () => ({ ok: true, token: "tok-1" }),
  ...over,
});

describe("GraphFileSource.listRecent", () => {
  it("SRC-05 filter: lists decks and PDFs newest first, never .pptm, other types or folders", async () => {
    const { source, calls } = graph(() => ({ body: fixture("children.json") }));
    const res = await source.listRecent(ctx(), 5);
    expect(res).toEqual({
      ok: true,
      files: [
        {
          kind: "file",
          id: "01SYNTHETICPDF",
          name: "Handout.PDF",
          type: "pdf",
          modifiedAt: Date.parse("2026-11-21T08:15:00Z"),
          size: 88200,
        },
        {
          kind: "file",
          id: "01SYNTHETICNEWDECK",
          name: "Lecture 4.pptx",
          type: "pptx",
          modifiedAt: Date.parse("2026-11-20T16:30:00Z"),
          size: 2481920,
        },
        {
          kind: "file",
          id: "01SYNTHETICMIDDECK",
          name: "Seminar.pptx",
          type: "pptx",
          modifiedAt: Date.parse("2026-11-10T12:00:00Z"),
          size: 640000,
        },
        {
          kind: "file",
          id: "01SYNTHETICOLDDECK",
          name: "Old lecture.pptx",
          type: "pptx",
          modifiedAt: Date.parse("2026-09-01T09:00:00Z"),
          size: 120400,
        },
      ],
    });
    expect(calls).toHaveLength(1);
  });

  it("asks for the drive root's children, sorted by edit time, with the user's token and nothing else", async () => {
    const { source, calls } = graph(() => ({ body: fixture("children.json") }));
    await source.listRecent(ctx(), 5);
    const call = calls[0] as Call;
    expect(call.url.origin + call.url.pathname).toBe("https://graph.microsoft.com/v1.0/me/drive/root/children");
    expect(call.url.searchParams.get("$orderby")).toBe("lastModifiedDateTime desc");
    expect(call.url.searchParams.get("$select")).toContain("lastModifiedDateTime");
    expect(call.headers.get("Authorization")).toBe("Bearer tok-1");
  });

  it("AUTH-06 scope: lists only inside the configured folder when the grant names one", async () => {
    const { source, calls } = graph(() => ({ body: fixture("children.json") }));
    await source.listRecent(ctx({ folderId: "01SYNTHETICFOLDER" }), 5);
    expect(calls[0]?.url.pathname).toBe("/v1.0/me/drive/items/01SYNTHETICFOLDER/children");
  });

  it("refuses a folder id that is not a plain item id, without calling Graph", async () => {
    const { source, calls } = graph(() => ({ body: "{}" }));
    expect(await source.listRecent(ctx({ folderId: "../../me/messages" }), 5)).toEqual({
      ok: false,
      error: "file_not_found",
    });
    expect(calls).toHaveLength(0);
  });

  it("honors the limit", async () => {
    const { source } = graph(() => ({ body: fixture("children.json") }));
    const res = await source.listRecent(ctx(), 2);
    expect(res.ok && res.files.map((f) => f.id)).toEqual(["01SYNTHETICPDF", "01SYNTHETICNEWDECK"]);
  });

  it("an empty drive is an empty list, not an error", async () => {
    const { source } = graph(() => ({ body: '{"value": []}' }));
    expect(await source.listRecent(ctx(), 5)).toEqual({ ok: true, files: [] });
  });

  it("a malformed body is source_unavailable", async () => {
    expect(await graph(() => ({ body: "<html>" })).source.listRecent(ctx(), 5)).toEqual({
      ok: false,
      error: "source_unavailable",
    });
    expect(await graph(() => ({ body: '{"value": 3}' })).source.listRecent(ctx(), 5)).toEqual({
      ok: false,
      error: "source_unavailable",
    });
  });

  it("passes the vault's error through without calling Graph", async () => {
    const { source, calls } = graph(() => ({ body: "{}" }));
    const noGrant = ctx({ accessToken: async () => ({ ok: false, error: "auth_required" }) });
    expect(await source.listRecent(noGrant, 5)).toEqual({ ok: false, error: "auth_required" });
    expect(calls).toHaveLength(0);
  });
});

describe("GraphFileSource error mapping", () => {
  const cases: [string, number, string, string][] = [
    ["401", 401, "error-401.json", "auth_required"],
    ["403 with a consent message", 403, "error-403-consent.json", "admin_consent_required"],
    ["403 otherwise", 403, "error-403-other.json", "source_unavailable"],
    ["404", 404, "error-404.json", "file_not_found"],
    ["429", 429, "error-429.json", "source_throttled"],
    ["503", 503, "error-429.json", "source_throttled"],
    ["500", 500, "error-429.json", "source_unavailable"],
  ];
  for (const [name, status, file, error] of cases) {
    it(`maps ${name} to ${error} for listing and resolving`, async () => {
      const { source } = graph(() => ({ status, body: fixture(file) }));
      expect(await source.listRecent(ctx(), 5)).toEqual({ ok: false, error });
      expect(await source.resolve(ctx(), "01SYNTHETICNEWDECK")).toEqual({ ok: false, error });
    });
  }

  it("a network failure is source_unavailable", async () => {
    const down = new GraphFileSource({
      fetch: async () => {
        throw new TypeError("network");
      },
      downloadHosts: HOSTS,
    });
    expect(await down.listRecent(ctx(), 5)).toEqual({ ok: false, error: "source_unavailable" });
  });
});

describe("GraphFileSource.resolve", () => {
  it("returns the name, type, size and the pre-authenticated URL of one item", async () => {
    const { source, calls } = graph(() => ({ body: fixture("item-pptx.json") }));
    const res = await source.resolve(ctx(), "01SYNTHETICNEWDECK");
    expect(res.ok && { ...res.file, body: undefined }).toEqual({
      name: "Lecture 4.pptx",
      type: "pptx",
      size: 2481920,
      url: "https://synthetic-my.sharepoint.com/personal/synthetic/_layouts/15/download.aspx?UniqueId=synthetic&tempauth=synthetic",
      body: undefined,
    });
    expect(calls[0]?.url.pathname).toBe("/v1.0/me/drive/items/01SYNTHETICNEWDECK");
    expect(calls[0]?.url.searchParams.get("$select")).toContain("@microsoft.graph.downloadUrl");
  });

  it("OPEN-04 host: a download URL outside GRAPH_DOWNLOAD_HOSTS is dropped, leaving streaming as the only way", async () => {
    const { source } = graph(() => ({ body: fixture("item-foreign-host.json") }));
    const res = await source.resolve(ctx(), "01SYNTHETICNEWDECK");
    expect(res.ok && res.file.url).toBeNull();
  });

  it("SRC-05 filter: refuses .pptm and folders as file_type_refused, and a malformed id as file_not_found", async () => {
    expect(await graph(() => ({ body: fixture("item-pptm.json") })).source.resolve(ctx(), "01SYNTHETICMACRO")).toEqual({
      ok: false,
      error: "file_type_refused",
    });
    expect(
      await graph(() => ({ body: fixture("item-folder.json") })).source.resolve(ctx(), "01SYNTHETICFOLDER"),
    ).toEqual({
      ok: false,
      error: "file_type_refused",
    });
    const { source, calls } = graph(() => ({ body: "{}" }));
    for (const id of ["../x", "a/b", "a?b=c", "a%2Fb", "", "x".repeat(300)]) {
      expect(await source.resolve(ctx(), id), id).toEqual({ ok: false, error: "file_not_found" });
    }
    expect(calls).toHaveLength(0);
  });

  it("SRC-05 filter: takes .pptx and .pdf in any case and refuses every other name, guest types included", async () => {
    const resolveName = async (name: string) => {
      const body = JSON.stringify({ id: "01SYNTHETIC", name, size: 1, file: {} });
      const res = await graph(() => ({ body })).source.resolve(ctx(), "01SYNTHETIC");
      return res.ok ? res.file.type : res.error;
    };
    expect(await resolveName("A.pptx")).toBe("pptx");
    expect(await resolveName("A.PPTX")).toBe("pptx");
    expect(await resolveName("a.b.Pdf")).toBe("pdf");
    for (const name of [
      "a.pptm",
      "a.ppt",
      "a.ppsx",
      "a.potx",
      "a.docx",
      "a.jpg",
      "a.png",
      "a.mp4",
      "pptx",
      "a.pptx.exe",
    ]) {
      expect(await resolveName(name), name).toBe("file_type_refused");
    }
  });

  it("body() streams the item's content with the token, following Graph's redirect", async () => {
    const { source, calls } = graph((url) =>
      url.pathname.endsWith("/content")
        ? { body: "PK-bytes", headers: { "Content-Length": "8" } }
        : { body: fixture("item-pptx.json") },
    );
    const res = await source.resolve(ctx(), "01SYNTHETICNEWDECK");
    if (!res.ok) throw new Error("resolve failed");
    const streamed = await res.file.body();
    expect(streamed.ok && streamed.length).toBe(8);
    expect(streamed.ok && (await new Response(streamed.stream).text())).toBe("PK-bytes");
    const content = calls.at(-1) as Call;
    expect(content.url.pathname).toBe("/v1.0/me/drive/items/01SYNTHETICNEWDECK/content");
    expect(content.redirect).toBe("follow");
    expect(content.headers.get("Authorization")).toBe("Bearer tok-1");
  });

  it("body() maps a Graph failure at stream time", async () => {
    const { source } = graph((url) =>
      url.pathname.endsWith("/content")
        ? { status: 404, body: fixture("error-404.json") }
        : { body: fixture("item-pptx.json") },
    );
    const res = await source.resolve(ctx(), "01SYNTHETICNEWDECK");
    if (!res.ok) throw new Error("resolve failed");
    expect(await res.file.body()).toEqual({ ok: false, error: "file_not_found" });
  });
});

describe("GraphFileSource.resolvePdf", () => {
  it("a PDF item is its own rendition", async () => {
    const { source, calls } = graph(() => ({ body: fixture("item-pdf.json") }));
    const res = await source.resolvePdf(ctx(), "01SYNTHETICPDF");
    expect(res.ok && res.file.type).toBe("pdf");
    expect(calls).toHaveLength(1);
  });

  it("a deck is converted with ?format=pdf; the redirect target becomes the URL when its host is allowed", async () => {
    const { source, calls } = graph((url) =>
      url.searchParams.get("format") === "pdf"
        ? { status: 302, headers: { Location: "https://synthetic.files.1drv.com/synthetic/lecture.pdf" } }
        : { body: fixture("item-pptx.json") },
    );
    const res = await source.resolvePdf(ctx(), "01SYNTHETICNEWDECK");
    expect(res.ok && { name: res.file.name, type: res.file.type, url: res.file.url }).toEqual({
      name: "Lecture 4.pdf",
      type: "pdf",
      url: "https://synthetic.files.1drv.com/synthetic/lecture.pdf",
    });
    const conversion = calls.at(-1) as Call;
    expect(conversion.url.pathname).toBe("/v1.0/me/drive/items/01SYNTHETICNEWDECK/content");
    expect(conversion.redirect).toBe("manual");
  });

  it("OPEN-04 host: a redirect to a foreign host is not offered as a URL", async () => {
    const { source } = graph((url) =>
      url.searchParams.get("format") === "pdf"
        ? { status: 302, headers: { Location: "https://elsewhere.example/lecture.pdf" } }
        : { body: fixture("item-pptx.json") },
    );
    const res = await source.resolvePdf(ctx(), "01SYNTHETICNEWDECK");
    expect(res.ok && res.file.url).toBeNull();
  });

  it("a conversion Graph cannot do is pdf_unavailable", async () => {
    const { source } = graph((url) =>
      url.searchParams.get("format") === "pdf"
        ? { status: 404, body: fixture("error-404.json") }
        : { body: fixture("item-pptx.json") },
    );
    expect(await source.resolvePdf(ctx(), "01SYNTHETICNEWDECK")).toEqual({ ok: false, error: "pdf_unavailable" });
  });
});

describe("hostAllowed", () => {
  it("matches subdomains of a wildcard and exact hosts, over https only", () => {
    expect(hostAllowed("https://a-my.sharepoint.com/x", HOSTS)).toBe(true);
    expect(hostAllowed("https://my.microsoftpersonalcontent.com/x", HOSTS)).toBe(true);
    expect(hostAllowed("https://sharepoint.com/x", HOSTS)).toBe(false);
    expect(hostAllowed("https://evilsharepoint.com/x", HOSTS)).toBe(false);
    expect(hostAllowed("https://a.sharepoint.com.evil.example/x", HOSTS)).toBe(false);
    expect(hostAllowed("https://evil.example/a.sharepoint.com", HOSTS)).toBe(false);
    expect(hostAllowed("https://a.sharepoint.com@evil.example/x", HOSTS)).toBe(false);
    expect(hostAllowed("http://a.sharepoint.com/x", HOSTS)).toBe(false);
    expect(hostAllowed("not a url", HOSTS)).toBe(false);
    expect(hostAllowed("https://A.SharePoint.com/x", HOSTS)).toBe(true);
  });
});
