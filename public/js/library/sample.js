// Add the Sample Deck (library.md section 8): one POST with an idempotency key, so a doubled tap adds one deck.
/** @param {any} page the page object library.js passes */
export function start(page) {
  /** @type {string | null} */
  let key = null;
  async function add() {
    key ??= crypto.randomUUID();
    const answer = await page.send("POST", "/api/library/sample", {}, { "Idempotency-Key": key });
    if (!answer.ok) return page.refuse(answer);
    key = null;
    await page.load();
  }
  return { add };
}
