// Shared page behaviour for v2: header state, menu, reveal-on-scroll. Pages work without it.
const root = document.documentElement;
root.classList.add("js");

const bar = document.querySelector(".bar");
const solidAt = () => (document.body.dataset.solidAt ? Number(document.body.dataset.solidAt) * window.innerHeight : 24);
const syncBar = () => bar?.classList.toggle("is-solid", window.scrollY > solidAt());
syncBar();
window.addEventListener("scroll", syncBar, { passive: true });

const menu = document.querySelector(".menu");
menu?.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => menu.removeAttribute("open")));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menu?.open) {
    menu.removeAttribute("open");
    menu.querySelector("summary")?.focus();
  }
});

const reveals = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window && reveals.length) {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      }
    }
  }, { rootMargin: "0px 0px -8% 0px" });
  reveals.forEach((el) => io.observe(el));
} else {
  reveals.forEach((el) => el.classList.add("is-in"));
}
