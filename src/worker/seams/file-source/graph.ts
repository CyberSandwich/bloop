// Microsoft Graph file source: lists decks in the allowed folder and resolves one item at open time.
// Uses fetch only. Calls: https://learn.microsoft.com/graph/api/driveitem-list-children and
// driveitem-get-content-format (the PDF conversion).
import type { FileEntry, SourceError } from "../../../shared/protocol.ts";
import { type FileSource, type Resolved, type SourceContext, typeOfName } from "./index.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
/** Graph ids are opaque but never contain a slash or percent sign; anything else is refused before it reaches a URL. */
const ITEM_ID = /^[A-Za-z0-9!_.~-]{1,256}$/;
/** Children cannot be filtered by type server-side, so a page is fetched and filtered here. */
const PAGE_SIZE = 100;
const SELECT = "id,name,size,lastModifiedDateTime,file,folder";

interface DriveItem {
  id?: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: object;
  folder?: object;
  "@microsoft.graph.downloadUrl"?: string;
}

/** `*.example.com` matches any subdomain of it; anything else must match exactly. HTTPS only. */
export function hostAllowed(url: string, patterns: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return patterns.some((p) => {
    const pattern = p.trim().toLowerCase();
    return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;
  });
}

/** 401, consent, 404 and throttling each map to one SourceError (interfaces.md section 3). */
async function errorFor(res: Response): Promise<SourceError> {
  if (res.status === 401) return "auth_required";
  if (res.status === 404) return "file_not_found";
  if (res.status === 429 || res.status === 503) return "source_throttled";
  if (res.status === 403) {
    const text = await res.text().catch(() => "");
    return /consent/i.test(text) ? "admin_consent_required" : "source_unavailable";
  }
  return "source_unavailable";
}

export class GraphFileSource implements FileSource {
  readonly kind = "graph";

  constructor(private readonly opts: { fetch: typeof fetch; downloadHosts: readonly string[] }) {}

  async listRecent(ctx: SourceContext, limit: number) {
    const parent = ctx.folderId ? `items/${ctx.folderId}` : "root";
    if (ctx.folderId && !ITEM_ID.test(ctx.folderId)) return { ok: false, error: "file_not_found" } as const;
    const query = `$select=${SELECT}&$orderby=lastModifiedDateTime desc&$top=${PAGE_SIZE}`;
    const res = await this.call(ctx, `/me/drive/${parent}/children?${query}`);
    if (!res.ok) return res;
    const page = (await res.value.json().catch(() => null)) as { value?: DriveItem[] } | null;
    if (!page || !Array.isArray(page.value)) return { ok: false, error: "source_unavailable" } as const;
    const files = page.value
      .flatMap((item): FileEntry[] => {
        const type = item.file && !item.folder && item.name ? typeOfName(item.name) : null;
        const modifiedAt = Date.parse(item.lastModifiedDateTime ?? "");
        if (!type || !item.id || !item.name || Number.isNaN(modifiedAt)) return [];
        return [{ id: item.id, name: item.name, type, modifiedAt, size: item.size ?? null }];
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, limit);
    return { ok: true, files } as const;
  }

  async resolve(ctx: SourceContext, fileId: string) {
    if (!ITEM_ID.test(fileId)) return { ok: false, error: "file_not_found" } as const;
    const res = await this.call(ctx, `/me/drive/items/${fileId}?$select=${SELECT},@microsoft.graph.downloadUrl`);
    if (!res.ok) return res;
    const item = (await res.value.json().catch(() => null)) as DriveItem | null;
    const type = item?.file && !item.folder && item.name ? typeOfName(item.name) : null;
    if (!item?.name) return { ok: false, error: "source_unavailable" } as const;
    if (!type) return { ok: false, error: "file_type_refused" } as const;
    const url = item["@microsoft.graph.downloadUrl"];
    const file: Resolved = {
      name: item.name,
      type,
      size: item.size ?? null,
      url: url && hostAllowed(url, this.opts.downloadHosts) ? url : null,
      body: () => this.stream(ctx, `/me/drive/items/${fileId}/content`),
    };
    return { ok: true, file } as const;
  }

  async resolvePdf(ctx: SourceContext, fileId: string) {
    const original = await this.resolve(ctx, fileId);
    if (!original.ok) return original;
    if (original.file.type === "pdf") return original;
    const path = `/me/drive/items/${fileId}/content?format=pdf`;
    // The conversion answers 302 with a pre-authenticated Location; read it without following.
    const res = await this.call(ctx, path, "manual");
    if (!res.ok) return res.error === "file_not_found" ? ({ ok: false, error: "pdf_unavailable" } as const) : res;
    const location = res.value.headers.get("Location");
    const file: Resolved = {
      name: original.file.name.replace(/\.pptx$/i, ".pdf"),
      type: "pdf",
      size: null,
      url: location && hostAllowed(location, this.opts.downloadHosts) ? location : null,
      body: () => this.stream(ctx, path),
    };
    return { ok: true, file } as const;
  }

  private async stream(ctx: SourceContext, path: string) {
    const res = await this.call(ctx, path);
    if (!res.ok) return res;
    if (!res.value.body) return { ok: false, error: "source_unavailable" } as const;
    const length = Number(res.value.headers.get("Content-Length"));
    return { ok: true, stream: res.value.body, length: Number.isFinite(length) && length > 0 ? length : null } as const;
  }

  /** One Graph request with the user's access token. A manual redirect counts as success. */
  private async call(ctx: SourceContext, path: string, redirect: "follow" | "manual" = "follow") {
    const token = await ctx.accessToken();
    if (!token.ok) return token;
    let res: Response;
    try {
      res = await this.opts.fetch(`${GRAPH}${path}`, {
        headers: { Authorization: `Bearer ${token.token}`, Accept: "application/json" },
        redirect,
      });
    } catch {
      return { ok: false, error: "source_unavailable" } as const;
    }
    if (res.ok || (redirect === "manual" && res.status === 302)) return { ok: true, value: res } as const;
    return { ok: false, error: await errorFor(res) } as const;
  }
}
