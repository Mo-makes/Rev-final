// Page-to-page slide direction for cross-document view transitions (CSS in v2.css).
// Classic script in <head> on purpose: "pagereveal" fires before the new page's first frame,
// so a deferred module would be too late. Browsers without view transitions ignore all of this.
(function () {
  var ORDER = ["index", "car", "garage", "about", "join", "sponsorship", "contact"];
  function rank(url) {
    try {
      var name = new URL(url).pathname.split("/").pop().replace(/\.html$/, "") || "index";
      return ORDER.indexOf(name);
    } catch (e) {
      return -1;
    }
  }
  window.addEventListener("pagereveal", function (event) {
    var vt = event.viewTransition;
    var activation = window.navigation && window.navigation.activation;
    if (!vt || !vt.types || !activation || !activation.from || !activation.entry) return;
    var from = rank(activation.from.url);
    var to = rank(activation.entry.url);
    // Moving left in the menu (or Back) slides the other way.
    var back = activation.navigationType === "traverse" ? to < from : to < from && from !== -1;
    vt.types.add(back ? "back" : "forward");
  });
})();
