// Lazy: a tap anywhere but a link, or Enter, cuts Session Ended to the server's floor (design.md section 7, Ended).
let heard = false;

/** @param {() => void} skip called on each such tap; listening starts once, at the first Session Ended */
export function listen(skip) {
  if (heard) return;
  heard = true;
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element && e.target.closest("a"))) skip();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.repeat && !(e.target instanceof HTMLAnchorElement)) skip();
  });
}
