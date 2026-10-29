// A focus timer. It runs inside the widget only, so it needs no permissions.
let cfg = { work: 25, shortBreak: 5, longBreak: 15, rounds: 4 };
let phase = "work";
let round = 1;
let left = 0;
let endsAt = null;
let timer = null;

const $ = (id) => document.getElementById(id);
const length = () => 60 * (phase === "work" ? cfg.work : phase === "long" ? cfg.longBreak : cfg.shortBreak);

function render() {
  const secs = Math.max(0, Math.ceil(endsAt ? (endsAt - Date.now()) / 1000 : left));
  $("phase").textContent = phase === "work" ? `Focus · round ${round} of ${cfg.rounds}` : phase === "long" ? "Long break" : "Short break";
  $("phase").classList.toggle("break", phase !== "work");
  $("time").textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  $("bar").style.width = `${(100 * (1 - secs / length())).toFixed(1)}%`;
  $("go").textContent = endsAt ? "Pause" : left < length() ? "Resume" : "Start";
  $("dots").replaceChildren(...Array.from({ length: cfg.rounds }, (_, i) => {
    const dot = document.createElement("i");
    if (i < round - (phase === "work" ? 1 : 0)) dot.className = "on";
    return dot;
  }));
  if (endsAt && secs === 0) next();
}

function next() {
  if (phase === "work") phase = round >= cfg.rounds ? "long" : "short";
  else {
    round = phase === "long" ? 1 : round + 1;
    phase = "work";
  }
  pause();
  left = length();
  render();
}

function start() {
  endsAt = Date.now() + left * 1000;
  timer = setInterval(render, 250);
}

function pause() {
  if (endsAt) left = Math.max(0, (endsAt - Date.now()) / 1000);
  endsAt = null;
  clearInterval(timer);
}

$("go").onclick = () => {
  if (endsAt) pause();
  else start();
  render();
};
$("skip").onclick = next;
$("reset").onclick = () => {
  pause();
  phase = "work";
  round = 1;
  left = length();
  render();
};

host.setHeader({ refresh: false });
host.onRefresh(async (reason) => {
  if (reason === "init" || reason === "config") {
    cfg = { ...cfg, ...(await host.config()) };
    if (!endsAt) left = length();
  }
  render();
});
