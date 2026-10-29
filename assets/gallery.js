// Gallery pages: renders catalog/catalog.json (built by tools/build.py) as cards with
// "Open in Glyx" (a glyx:// link the app confirms before changing anything) and a download.

const page = document.body.dataset.page; // "templates" | "widgets"
const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.filter((c) => c != null && c !== false));
  return el;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${name}`);
  svg.append(use);
  return svg;
}

let toastTimer;
function toast(...content) {
  const el = $("#toast");
  el.replaceChildren(...content);
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 9000);
}

/** Without Glyx installed the link does nothing, so say what else to do. */
function openInGlyx(item, kind) {
  location.href = item.link;
  const file = item.file.split("/").pop();
  toast(h("b", {}, "Opening Glyx… "),
    `Glyx shows what will change before anything is applied. Nothing happened? Download ${file} and drop it on the Glyx window`,
    kind === "source" ? " (Glyx Full)." : ".");
}

const fileButton = (item, label) => h("a", { class: "btn", href: item.file, download: "" }, icon("i-download"), label);
const openButton = (item, kind, label) => h("button", { class: "btn primary", onclick: () => openInGlyx(item, kind) }, icon("i-open"), label);

function yamlView(text) {
  const pre = h("pre", { class: "yaml" });
  for (const line of text.split("\n")) {
    const m = line.match(/^(\s*(?:- )?)([\w.-]+)(:)(.*)$/);
    if (/^\s*#/.test(line)) pre.append(h("span", { class: "c" }, line), "\n");
    else if (m) pre.append(m[1], h("span", { class: "k" }, m[2]), m[3] + m[4], "\n");
    else pre.append(line, "\n");
  }
  return pre;
}

function templateCard(t) {
  const preview = h("button", { class: "btn quiet", "aria-expanded": "false" }, "Preview");
  const card = h("article", { class: "card" },
    h("h3", {}, t.name),
    h("p", {}, t.description),
    h("div", { class: "meta" }, `${t.pages.length} page${t.pages.length > 1 ? "s" : ""} · ${t.count} widgets`),
    h("div", { class: "tags" }, ...t.widgets.map((w) => h("span", { class: "tag" }, w))),
    h("div", { class: "actions" }, openButton(t, "template", "Open in Glyx"), fileButton(t, "Download .yml"), preview));
  let view = null;
  preview.onclick = async () => {
    if (view) {
      view.remove();
      view = null;
      preview.setAttribute("aria-expanded", "false");
      return;
    }
    preview.setAttribute("aria-expanded", "true");
    view = yamlView(await (await fetch(t.file)).text());
    card.insertBefore(view, card.lastElementChild);
  };
  return card;
}

function widgetCard(w) {
  return h("article", { class: "card" },
    h("h3", {}, w.name, h("small", {}, w.pluginName)),
    h("p", {}, w.description),
    h("div", { class: "tags" }, w.builtin ? h("span", { class: "tag" }, "Built in") : h("span", { class: "tag src" }, `Needs ${w.pluginName}`),
      ...w.tags.map((t) => h("span", { class: "tag" }, t))),
    h("div", { class: "actions" }, openButton(w, "widget", "Add to Glyx"), fileButton(w, "Download .json")));
}

function sourceCard(s) {
  const kb = Math.max(1, Math.round(s.size / 1024));
  return h("article", { class: "card" },
    h("h3", {}, s.name, h("small", {}, `${s.version} · ${s.id}`)),
    h("p", {}, s.description),
    h("div", { class: "meta" }, `By ${s.author} · ${kb} KB`),
    s.permissions.length
      ? h("ul", { class: "perms" }, ...s.permissions.map((p) => h("li", {}, p)))
      : h("ul", { class: "perms none" }, h("li", {}, "Needs no network, files or system access")),
    h("div", { class: "actions" }, openButton(s, "source", "Install in Glyx"), fileButton(s, "Download .zip"),
      h("a", { class: "btn quiet", href: s.code }, icon("github"), "Code")));
}

function render(catalog) {
  const sections = page === "templates"
    ? [{ id: "templates", items: catalog.templates, card: templateCard }]
    : [{ id: "widgets", items: catalog.widgets, card: widgetCard }, { id: "sources", items: catalog.sources, card: sourceCard }];
  const tags = [...new Set(sections.flatMap((s) => s.items.flatMap((i) => i.tags || [])))].sort();
  let tag = new URLSearchParams(location.search).get("tag");
  if (!tags.includes(tag)) tag = null;

  const search = $("#search");
  const chips = $("#chips");
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    for (const s of sections) {
      const shown = s.items.filter((i) => (!tag || i.tags?.includes(tag)) &&
        (!q || [i.name, i.description, i.pluginName, ...(i.widgets || []), ...(i.tags || [])].join(" ").toLowerCase().includes(q)));
      $(`#${s.id}`).replaceChildren(...(shown.length ? shown.map(s.card) : [h("div", { class: "empty" }, "Nothing matches.")]));
    }
    chips.replaceChildren(...[null, ...tags].map((t) => h("button", {
      class: "chip", "aria-pressed": String(t === tag), onclick: () => {
        tag = t;
        const url = new URL(location.href);
        if (t) url.searchParams.set("tag", t);
        else url.searchParams.delete("tag");
        history.replaceState(null, "", url);
        draw();
      },
    }, t ?? "All")));
  };
  search.oninput = draw;
  draw();
}

fetch("/catalog/catalog.json")
  .then((r) => r.json())
  .then(render)
  .catch(() => {
    for (const el of document.querySelectorAll(".grid")) el.replaceChildren(h("div", { class: "empty" }, "The catalog could not be loaded. Try again later."));
  });
