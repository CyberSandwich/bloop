// The numbers the articles state, tied to the files that own them (docs/design.md section 6, Site build): a limit
// changed in wrangler.jsonc or the Worker fails here until the article says the same.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALPHABET } from "../../public/js/shared/codes.js";
import { MISS_LIMIT, MISS_WINDOW_MS } from "../../src/worker/do/directory-rules.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
const article = (slug: string) => read(`content/articles/${slug}.md`).replace(/\s+/g, " ");
const wrangler = read("wrangler.jsonc");
const threatModel = read("docs/threat-model.md");
const privacy = read("content/privacy.md");
const config = (name: string) => Number(new RegExp(`"${name}": "(\\d+)"`).exec(wrangler)?.[1]);
const limit = (binding: string) => Number(new RegExp(`"${binding}"[^}]*"limit": (\\d+)`).exec(wrangler)?.[1]);
const hours = (minutes: number) => minutes / 60;

describe("How bloop Works states the limits the Worker enforces", () => {
  const text = article("how-bloop-works");

  it("a code lives for CODE_TTL_SECONDS", () => {
    expect(text).toContain(`A code works once and lasts ${config("CODE_TTL_SECONDS")} seconds`);
  });

  it("a session starts at SESSION_DEFAULT_MINUTES, up to SESSION_MAX_MINUTES, and DEMO_MAX_MINUTES in the Demo", () => {
    expect(text).toContain(
      `Every session starts at ${hours(config("SESSION_DEFAULT_MINUTES"))} hour. The presenter can change that on the phone, up to ${hours(config("SESSION_MAX_MINUTES"))} hours (${hours(config("DEMO_MAX_MINUTES"))} hours in the public Demo)`,
    );
  });

  it("a link lives for LINK_FIRST_FETCH_SECONDS unused, LINK_FETCH_WINDOW_SECONDS after first use, LINK_MAX_FETCHES fetches", () => {
    expect(text).toContain(
      `It dies ${config("LINK_FIRST_FETCH_SECONDS") / 60} minutes after it is made if nobody uses it`,
    );
    expect(text).toContain(`${config("LINK_FETCH_WINDOW_SECONDS") / 60} minutes after its first use`);
    expect(text).toContain(`at most ${config("LINK_MAX_FETCHES")} fetches`);
  });
});

describe("Threat Model for IT Teams states the limits the Worker and the threat model own", () => {
  const text = article("threat-model-for-it-teams");

  it("codes: one use, CODE_TTL_SECONDS, CODE_LENGTH characters from the 30-symbol alphabet", () => {
    expect(text).toContain(`A code works once and lasts ${config("CODE_TTL_SECONDS")} seconds`);
    expect(text).toContain(`A code is ${config("CODE_LENGTH")} characters from an alphabet of ${ALPHABET.length}`);
    const millions = Math.round(ALPHABET.length ** config("CODE_LENGTH") / 1e7) * 10;
    expect(text).toContain(`about ${millions} million possibilities`);
  });

  it("guessing: MISS_LIMIT misses per window, and RL_CLAIM claims a minute", () => {
    expect(text).toContain(`${MISS_LIMIT} misses per ${MISS_WINDOW_MS / 60_000} minutes`);
    expect(text).toContain(`${limit("RL_CLAIM")} claims per minute`);
    expect(wrangler).toMatch(/"RL_CLAIM"[^}]*"period": 60/);
  });

  it("links: the same life as How bloop Works, and at most 1 plus LINK_MINTS_PER_ITEM links per file", () => {
    expect(text).toContain(`${config("LINK_FIRST_FETCH_SECONDS") / 60} minutes after it is made if unused`);
    expect(text).toContain(`${config("LINK_FETCH_WINDOW_SECONDS") / 60} minutes after first use`);
    expect(text).toContain(`at most ${config("LINK_MAX_FETCHES")} fetches`);
    expect(text).toContain(`at most ${1 + config("LINK_MINTS_PER_ITEM")} links per file`);
  });

  it("sessions: the default length and the grant's idle days", () => {
    expect(text).toContain(`${hours(config("SESSION_DEFAULT_MINUTES"))} hour by default`);
    expect(text).toContain(`access unused for ${config("GRANT_IDLE_DAYS")} days is deleted`);
  });

  it("tokens: the threat model owns the 1 hour access token and the 30 day grant", () => {
    expect(text).toContain("No access token lasts more than 1 hour");
    expect(threatModel).toMatch(/No access token outlives 1 h/);
    expect(threatModel).toMatch(/Grants unused for 30 days are deleted/);
  });
});

describe("Data and Retention states the periods the Worker runs and the threat model lists", () => {
  const text = article("data-and-retention");

  it("session and access records: AUDIT_RETENTION_DAYS, DEMO_RETENTION_DAYS in the Demo", () => {
    expect(text).toContain(
      `${config("AUDIT_RETENTION_DAYS")} days. In the Demo, ${config("DEMO_RETENTION_DAYS")} days`,
    );
    expect(threatModel).toContain(
      `| ${config("AUDIT_RETENTION_DAYS")} days (\`AUDIT_RETENTION_DAYS\`); demo ${config("DEMO_RETENTION_DAYS")} days |`,
    );
    expect(privacy).toContain(
      `${config("AUDIT_RETENTION_DAYS")} days. In the Demo, ${config("DEMO_RETENTION_DAYS")} days`,
    );
  });

  it("usage counts: METRICS_RETENTION_DAYS, then daily totals for 2 years", () => {
    expect(text).toContain(`${config("METRICS_RETENTION_DAYS")} days, then daily totals for 2 years`);
    expect(threatModel).toContain(
      `| metric events | D1 | ${config("METRICS_RETENTION_DAYS")} days, then daily counts for 2 years |`,
    );
  });

  it("a guest file: gone at session end, swept after the longest session, 1 day in storage", () => {
    expect(text).toContain("A storage rule deletes any guest file after 1 day");
    expect(read("tools/r2-lifecycle.json")).toMatch(/"id": "guest-files-1-day"[\s\S]*"maxAge": 86400/);
    expect(text).toContain(`the longest a session can last (${hours(config("SESSION_MAX_MINUTES"))} hours live)`);
    expect(threatModel).toContain("| guest file row | D1 | 30 days after deletion |");
    expect(text).toContain("30 days after the file is deleted");
  });

  it("failed code attempts, request logs and email keep what the threat model and the notice say", () => {
    expect(text).toMatch(/Failed code attempts[^|]*\| [^|]*\| 10 minutes/);
    expect(threatModel).toContain("| failed-lookup counters | Directory DO | 10 min |");
    expect(text).toContain("At most 7 days, with no personal data");
    expect(threatModel).toMatch(/\| Worker logs \| Cloudflare \| [^|]*at most 7 days, no personal data \|/);
    expect(text).toContain("2 years after the last message in a thread");
    expect(privacy).toContain("2 years after the last message in a thread");
  });
});

describe("the docs point to the articles that explain them", () => {
  it.each([
    ["docs/threat-model.md", "/articles/threat-model-for-it-teams"],
    ["docs/threat-model.md", "/articles/data-and-retention"],
    ["docs/architecture.md", "/articles/how-bloop-works"],
    ["docs/threat-model.md", "/articles/what-stays-on-the-pc"],
  ])("%s links %s", (doc, path) => {
    expect(read(doc)).toContain(path);
  });
});
