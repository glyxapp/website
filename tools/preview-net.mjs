// Sample answers for the previews of widgets that need an account: GitHub, Linear, Jira, Home
// Assistant and Agenda. Only capture-previews.mjs uses them. It gives those widgets a stand-in
// secret (from an environment variable of the Glyx it runs, never Credential Manager), fills
// the options a user fills in (a Jira site, a calendar link), and answers their requests from
// here, in the page, so nothing is sent anywhere. The people, repositories and issues are made
// up. An imported template has none of this: each of these widgets asks to be set up.

/** The environment variable whose value stands in for every secret in the previews. */
export const SECRET_ENV = "GLYX_PREVIEW_SECRET";
const secret = `\${env:${SECRET_ENV}}`;

/** Options a preview fills in where the template leaves them for the user. */
export function fill(plugin, config = {}) {
  const c = { ...config };
  switch (plugin) {
    case "glyx.github":
    case "glyx.home-assistant":
      c.token = secret;
      break;
    case "glyx.linear":
      c.key = secret;
      break;
    case "glyx.jira":
      Object.assign(c, { site: c.site || "https://acme.atlassian.net", email: c.email || "lan@acme.vn", token: secret });
      break;
    case "glyx.agenda":
      if (!c.calendars?.length) c.calendars = [{ url: secret, name: "Work", color: "#4f8cff" }];
      break;
    default:
      return config;
  }
  return c;
}

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}${pad(d.getMinutes())}00`;
const iso = (minsAgo, now) => new Date(now - minsAgo * 60_000).toISOString();
const dayAt = (now, days) => {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return d;
};

/** The day's meetings around `now` (local time), with one starting in a few minutes. */
function ics(now) {
  const t = new Date(now);
  const today = ymd(t);
  const soon = new Date(Math.ceil((now + 6 * 60_000) / 300_000) * 300_000);
  const soonEnd = new Date(soon.getTime() + 45 * 60_000);
  const later = new Date(soon.getTime() + 2 * 3_600_000);
  const laterEnd = new Date(later.getTime() + 30 * 60_000);
  const ev = (uid, start, end, summary, extra = []) =>
    ["BEGIN:VEVENT", `UID:${uid}@preview`, `DTSTART;TZID=Asia/Ho_Chi_Minh:${start}`, `DTEND;TZID=Asia/Ho_Chi_Minh:${end}`, `SUMMARY:${summary}`, ...extra, "END:VEVENT"];
  // The next two working days, so no meeting lands on a weekend whatever day this runs.
  const work = [];
  for (let n = 1; work.length < 2; n++) if (![0, 6].includes(dayAt(now, n).getDay())) work.push(ymd(dayAt(now, n)));
  const [tomorrow, after] = work;
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Work", "X-WR-TIMEZONE:Asia/Ho_Chi_Minh",
    ...ev("standup", `${ymd(dayAt(now, -7))}T091500`, `${ymd(dayAt(now, -7))}T093000`, "Daily stand-up",
      ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR","DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3ameeting_preview%40thread.v2/0"]),
    ...ev("review", `${today}T${hm(soon)}`, `${today}T${hm(soonEnd)}`, "Design review: checkout v2",
      ["LOCATION:Phòng họp 4B", "DESCRIPTION:https://meet.google.com/abc-defg-hij"]),
    ...ev("one", `${today}T${hm(later)}`, `${today}T${hm(laterEnd)}`, "1:1 with Minh", ["URL:https://acme.zoom.us/j/123456789"]),
    ...ev("plan", `${tomorrow}T100000`, `${tomorrow}T113000`, "Sprint planning", ["LOCATION:Phòng họp lớn"]),
    ...ev("client", `${tomorrow}T150000`, `${tomorrow}T160000`, "Demo for Sakura Retail",
      ["DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3ameeting_client%40thread.v2/0"]),
    ...ev("retro", `${after}T160000`, `${after}T170000`, "Retro", []),
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

function github(now) {
  const pr = (number, repo, title, author, mins, comments, review, ci, draft = false) => ({
    number, title, url: `https://github.com/${repo}/pull/${number}`, updatedAt: iso(mins, now), repository: { nameWithOwner: repo },
    author: { login: author, avatarUrl: "" }, comments: { totalCount: comments }, isDraft: draft, reviewDecision: review,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: ci } } }] },
  });
  const issue = (number, repo, title, author, mins, labels) => ({
    number, title, url: `https://github.com/${repo}/issues/${number}`, updatedAt: iso(mins, now), repository: { nameWithOwner: repo },
    author: { login: author, avatarUrl: "" }, comments: { totalCount: 2 }, labels: { nodes: labels },
  });
  return {
    data: {
      viewer: { login: "lan-tran" },
      review: { issueCount: 4, nodes: [
        pr(412, "acme/checkout", "Retry payment webhooks with backoff", "minh-ng", 25, 6, "REVIEW_REQUIRED", "SUCCESS"),
        pr(409, "acme/api", "Cache product search for 60 s", "hoa-le", 70, 3, "REVIEW_REQUIRED", "PENDING"),
        pr(1187, "acme/web", "New cart drawer on mobile", "duc-pham", 180, 11, "CHANGES_REQUESTED", "SUCCESS"),
        pr(77, "acme/infra", "Move staging to Postgres 17", "an-vo", 400, 1, "REVIEW_REQUIRED", "FAILURE"),
      ] },
      mine: { issueCount: 2, nodes: [
        pr(415, "acme/api", "Rate limit the public API per key", "lan-tran", 40, 2, "APPROVED", "SUCCESS"),
        pr(1190, "acme/web", "Dark mode for the dashboard", "lan-tran", 300, 0, "REVIEW_REQUIRED", "PENDING", true),
      ] },
      assigned: { issueCount: 2, nodes: [
        issue(1201, "acme/web", "Checkout button hidden behind the cookie bar on iPhone SE", "support-bot", 90, [{ name: "bug", color: "d73a4a" }]),
        issue(390, "acme/api", "Document the webhook signature", "hoa-le", 1500, [{ name: "docs", color: "0075ca" }]),
      ] },
    },
  };
}

function linear(now) {
  const day = (n) => {
    const d = dayAt(now, n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const node = (id, title, priority, due, mins, name, type, color, project, cycle = 24) => ({
    identifier: id, title, url: `https://linear.app/acme/issue/${id}`, priority, dueDate: due, updatedAt: iso(mins, now),
    state: { name, type, color }, cycle: cycle ? { number: cycle, name: null } : null, project: project ? { name: project } : null,
  });
  return {
    data: { viewer: { name: "Lan Tran", displayName: "lan", assignedIssues: { pageInfo: { hasNextPage: false }, nodes: [
      node("ENG-142", "Rate limiter for the public API", 1, day(0), 30, "In Review", "started", "#f2c94c", "Platform"),
      node("ENG-151", "Hiring plan for Q1", 2, day(2), 120, "In Progress", "started", "#5e6ad2", "Team"),
      node("ENG-150", "Migrate the billing cron", 3, day(6), 600, "Todo", "unstarted", "#e2e2e2", "Billing"),
      node("ENG-163", "Quarterly review notes", 3, day(9), 900, "Todo", "unstarted", "#e2e2e2", null),
      node("ENG-160", "Flaky e2e test on Windows", 4, null, 3000, "Backlog", "backlog", "#bec2c8", "Platform", null),
    ] } } },
  };
}

function jira(now) {
  const d = (n) => {
    const x = dayAt(now, n);
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  };
  const issue = (key, summary, status, cat, color, prio, due, mins) => ({
    key, fields: { summary, status: { name: status, statusCategory: { key: cat, colorName: color } }, priority: { name: prio }, duedate: due, updated: iso(mins, now) },
  });
  return {
    isLast: true,
    issues: [
      issue("CRM-311", "Báo giá cho khách Sakura Retail", "In Progress", "indeterminate", "yellow", "Highest", d(0), 20),
      issue("CRM-305", "Cập nhật hợp đồng bảo trì năm 2027", "In Progress", "indeterminate", "yellow", "High", d(1), 140),
      issue("HR-88", "Lịch phỏng vấn vị trí kế toán", "In Review", "indeterminate", "yellow", "Medium", d(2), 300),
      issue("CRM-298", "Gửi báo cáo doanh số tháng 11", "To Do", "new", "blue-gray", "High", d(3), 600),
      issue("OPS-77", "Gia hạn tên miền và chứng chỉ SSL", "To Do", "new", "blue-gray", "Medium", d(9), 1400),
      issue("CRM-290", "Khảo sát mức hài lòng quý 4", "To Do", "new", "blue-gray", "Low", null, 4000),
    ],
  };
}

const HA = {
  "light.phong_khach": ["on", { friendly_name: "Phòng khách", brightness: 204 }],
  "light.phong_ngu": ["off", { friendly_name: "Phòng ngủ" }],
  "light.bep": ["on", { friendly_name: "Bếp", brightness: 255 }],
  "light.ban_cong": ["off", { friendly_name: "Ban công" }],
  "switch.may_loc_khong_khi": ["on", { friendly_name: "Máy lọc không khí" }],
  "switch.binh_nong_lanh": ["off", { friendly_name: "Bình nóng lạnh" }],
  "fan.quat_tran": ["on", { friendly_name: "Quạt trần" }],
  "input_boolean.che_do_vang_nha": ["off", { friendly_name: "Chế độ vắng nhà" }],
  "sensor.nhiet_do_phong_khach": ["24.6", { friendly_name: "Phòng khách", unit_of_measurement: "°C", device_class: "temperature" }],
  "sensor.do_am_phong_khach": ["68", { friendly_name: "Độ ẩm", unit_of_measurement: "%", device_class: "humidity" }],
  "sensor.nhiet_do_phong_ngu": ["23.1", { friendly_name: "Phòng ngủ", unit_of_measurement: "°C", device_class: "temperature" }],
  "binary_sensor.cua_chinh": ["off", { friendly_name: "Cửa chính", device_class: "door" }],
  "binary_sensor.chuyen_dong_hanh_lang": ["on", { friendly_name: "Hành lang", device_class: "motion" }],
  "sensor.dien_tieu_thu_hom_nay": ["7.4", { friendly_name: "Điện hôm nay", unit_of_measurement: "kWh", device_class: "energy" }],
};

/**
 * The answers, as [pattern, status, body] with `pattern` the source of a RegExp tested on the
 * URL a widget asks for (secrets in it are still their stand-ins).
 */
export function routes(now = Date.now()) {
  const out = [
    ["^https://api\\.github\\.com/graphql", 200, JSON.stringify(github(now))],
    ["^https://api\\.linear\\.app/graphql", 200, JSON.stringify(linear(now))],
    ["^https://acme\\.atlassian\\.net/rest/api/3/search", 200, JSON.stringify(jira(now))],
    ["__glyx_secret_calendars_\\d+_url__", 200, ics(now)],
  ];
  for (const [id, [state, attributes]] of Object.entries(HA)) {
    out.push([`/api/states/${id.replace(/\./g, "\\.")}$`, 200, JSON.stringify({ entity_id: id, state, attributes, last_changed: iso(35, now) })]);
  }
  return out;
}

/**
 * Page code that answers the widgets' fetches that match `list` (from routes()) and passes every
 * other call on: the shell looks up window.__TAURI__.core.invoke at each call (src/host.js).
 */
export function interceptor(list) {
  return `(() => {
    const core = window.__TAURI__.core;
    const real = core.__previewReal || core.invoke;
    const list = ${JSON.stringify(list)}.map(([p, status, text]) => [new RegExp(p), status, text]);
    const invoke = (cmd, args, ...rest) => {
      if (cmd === "plugin_call" && args?.method === "fetch" && typeof args.args?.url === "string") {
        const hit = list.find(([re]) => re.test(args.args.url));
        if (hit) return Promise.resolve({ status: hit[1], url: args.args.url, headers: {}, text: hit[2], elapsedMs: 40, cached: false });
      }
      return real(cmd, args, ...rest);
    };
    try { core.__previewReal = real; core.invoke = invoke; } catch {}
    if (core.invoke !== invoke) {
      window.__TAURI__ = Object.assign(Object.create(Object.getPrototypeOf(window.__TAURI__)), window.__TAURI__, { core: Object.assign({}, core, { invoke, __previewReal: real }) });
    }
    return window.__TAURI__.core.invoke === invoke;
  })()`;
}
