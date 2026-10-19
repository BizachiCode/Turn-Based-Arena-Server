// GM panel client, part 5: boot sequence (runs after every view registered itself).
export const SCRIPT_BOOT = String.raw`
function optionList(values) {
  return values.map(function (value) { return '<option value="' + esc(value) + '"></option>'; }).join("");
}
function fillCatalogLists() {
  var c = S.catalog;
  if (!c) return;
  $("dlCurrencies").innerHTML = optionList(c.currencies.map(function (item) { return item.id; }));
  $("dlCharacters").innerHTML = optionList(c.characters.map(function (item) { return item.id; }));
  $("dlRuneSets").innerHTML = optionList(c.runeSets.map(function (item) { return item.id; }));
}

Array.prototype.forEach.call(document.querySelectorAll("[data-icon]"), function (el) {
  el.innerHTML = icon(el.getAttribute("data-icon"), 18);
});
$("envLabel").textContent = window.location.host;
renderSession();
window.addEventListener("hashchange", route);
window.setInterval(function () { if (!S.timer) refreshStatus(); }, 30000);
if (getKey()) {
  refreshStatus();
  loadCatalog();
}
route();
if (!getKey()) A.session();
`;
