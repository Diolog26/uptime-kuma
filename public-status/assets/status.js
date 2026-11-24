/* Diolog status page. Renders /api/diolog/status (server/diolog/status-api.js): the first copy is
   inlined in the page, and it refreshes every minute. ?preview=<state> renders a labelled sample of
   one state for review; it never replaces live data silently. */
(() => {
    "use strict";

    const script = document.currentScript;
    const slug = decodeURIComponent(script.dataset.slug || "");
    const REFRESH_MS = 60 * 1000;
    const RETRY_MS = 30 * 1000;
    const SUPPORT = "hello@diolog.com.au";
    const $ = (id) => document.getElementById(id);

    let data = null;
    let lastGood = null;
    let failing = false;
    let timer = null;
    let showAllHistory = false;

    /* ── formatting ─────────────────────────────────────────────────────────── */
    const timeFmt = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" });
    const clockFmt = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
    const dateFmt = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short" });
    const longDate = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" });
    const utcDay = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    const zone = (() => {
        const part = new Intl.DateTimeFormat("en-AU", { timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
        return part ? part.value : "local time";
    })();
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const time = (iso) => timeFmt.format(new Date(iso)).replace(" ", " ");
    const minutes = (n) => (n < 60 ? `${n} minute${n === 1 ? "" : "s"}` : `${Math.floor(n / 60)} h ${n % 60 ? `${n % 60} min` : ""}`.trim());
    const icon = (name, cls = "i") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
    const list = (titles) => (titles.length < 3 ? titles.join(" and ") : `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`);

    /** Uptime as text, never rounded up to a perfect score it did not earn. */
    function uptimeText(svc) {
        if (svc.uptime === null) {
            return null;
        }
        if (svc.downChecks === 0) {
            return "100%";
        }
        return `${(Math.floor(svc.uptime * 10000) / 100).toFixed(2)}%`;
    }

    const STATE = {
        up: { label: "Working", icon: "up" },
        degraded: { label: "Having problems", icon: "degraded" },
        down: { label: "Down", icon: "down" },
        maintenance: { label: "Maintenance", icon: "maintenance" },
        nodata: { label: "No data yet", icon: "nodata" },
    };

    /* ── the verdict ────────────────────────────────────────────────────────── */
    function verdict(d) {
        const by = (s) => d.services.filter((x) => x.state === s);
        const down = by("down");
        const degraded = by("degraded");
        const maint = by("maintenance");
        const nodata = by("nodata");
        const check = "Checks keep running every minute, and this page updates on its own.";

        if (nodata.length === d.services.length) {
            return { state: "nodata", h: "Checking Diolog services.", lede: "The first checks are running. This page fills in within a minute." };
        }
        if (down.length) {
            const h =
                down.length === d.services.length
                    ? "Diolog services are down."
                    : down.length > 2
                      ? "Several Diolog services are down."
                      : `${list(down.map((s) => s.title))} ${down.length === 1 ? "is" : "are"} down.`;
            const since = down[0].stateSince ? ` since ${time(down[0].stateSince)}` : "";
            const lede = `${down.length === 1 ? `${down[0].title} has` : "They have"} failed three checks in a row${since}. ${check}`;
            return { state: "down", h, lede };
        }
        if (degraded.length) {
            const h = degraded.length === 1 ? `${degraded[0].title} is having problems.` : "Some Diolog services are having problems.";
            const lede = `${degraded.length === 1 ? "It is" : "They are"} failing some checks or responding slowly. ${check}`;
            return { state: "degraded", h, lede };
        }
        if (maint.length) {
            const m = d.maintenance[0];
            const until = m && m.endsAt ? `, until ${time(m.endsAt)}` : "";
            return { state: "maintenance", h: `Scheduled maintenance on ${list(maint.map((s) => s.title))}.`, lede: `${m ? m.title : "Planned work is under way"}${until}.` };
        }
        return { state: "up", h: "All Diolog services are working.", lede: "Every service passed its most recent check." };
    }

    function renderHero(d) {
        const v = d ? verdict(d) : { state: "unavailable", h: "Status is unavailable right now.", lede: "" };
        const badge = $("badge");
        const iconFor = { up: "up", degraded: "degraded", down: "down", maintenance: "maintenance", nodata: "nodata", unavailable: "offline" };
        badge.dataset.state = failing && d ? "stale" : v.state;
        badge.innerHTML = `<svg class="i"><use href="#i-${failing && d ? "offline" : iconFor[v.state]}"/></svg>`;
        $("verdict").textContent = v.h;
        // "Live" only while the figures are current; the pulsing dot would otherwise vouch for old data.
        const live = Boolean(d) && !failing;
        $("kicker").dataset.live = live ? "on" : "off";
        $("kicker-text").textContent = live ? "Live status" : d ? "Status, not refreshing" : "Status";
        document.title = d && v.state !== "up" ? `${v.h.replace(/\.$/, "")} - Diolog status` : "Diolog status";

        if (!d) {
            $("lede").innerHTML = `This page could not load the latest checks. It tries again every 30 seconds. For help now, email <a href="mailto:${SUPPORT}">${SUPPORT}</a>.`;
            $("meta").innerHTML = "";
            return;
        }
        $("lede").textContent = v.lede;
        const checked = d.checkedAt ? `${icon("clock")}Last checked ${clockFmt.format(new Date(d.checkedAt))}` : `${icon("clock")}Waiting for the first check`;
        const stale = failing
            ? `<span class="stale">${icon("offline")}Couldn't refresh. Showing checks from ${time(lastGood.checkedAt || lastGood.generatedAt)}, trying again.</span>`
            : `<span>Checked every minute from Sydney</span>`;
        $("meta").innerHTML = `<span>${checked}</span>${stale}`;
    }

    /* ── notices: the Diolog team's notes and maintenance under way ─────────── */
    function renderNotices(d) {
        const out = [];
        for (const n of d.incidents.active) {
            const kick = n.tone === "bad" ? "Outage update" : n.tone === "warn" ? "Update from Diolog" : "Notice from Diolog";
            const body = String(n.content || "")
                .split(/\n{2,}/)
                .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
                .join("");
            const updated = n.updatedAt && n.updatedAt !== n.createdAt ? `, updated ${time(n.updatedAt)}` : "";
            out.push(`<article class="card notice ${n.tone}">${icon(n.tone === "info" ? "info" : "degraded")}<span class="n-kick">${kick}</span>
                <h3>${esc(n.title)}</h3>${body ? `<div class="n-body">${body}</div>` : ""}
                <p class="n-meta">Posted ${dateFmt.format(new Date(n.createdAt))}, ${time(n.createdAt)}${updated} (${zone})</p></article>`);
        }
        for (const m of d.maintenance) {
            const until = m.endsAt ? `Until ${dateFmt.format(new Date(m.endsAt))}, ${time(m.endsAt)} (${zone})` : "Under way now";
            out.push(`<article class="card notice info">${icon("maintenance")}<span class="n-kick">Scheduled maintenance</span>
                <h3>${esc(m.title)}</h3>${m.description ? `<div class="n-body"><p>${esc(m.description)}</p></div>` : ""}
                <p class="n-meta">${until}</p></article>`);
        }
        $("notices").innerHTML = out.join("");
    }

    /* ── services ───────────────────────────────────────────────────────────── */
    function dayClass(day) {
        if (day.uptime === null) {
            return "none";
        }
        if (day.downMinutes >= 30) {
            return "bad";
        }
        if (day.downMinutes > 0 || day.uptime < 1) {
            return "warn";
        }
        return "up";
    }

    function dayText(day, since) {
        const label = utcDay.format(new Date(`${day.date}T00:00:00Z`));
        if (day.uptime === null) {
            return { label, line: since && new Date(`${day.date}T23:59:59Z`) < since ? `No data. Monitoring began ${longDate.format(since)}.` : "No checks recorded this day." };
        }
        if (day.downMinutes > 0) {
            return { label, line: `Down for about ${minutes(day.downMinutes)}` };
        }
        if (day.uptime < 1) {
            return { label, line: "Some checks failed" };
        }
        return { label, line: "No downtime recorded" };
    }

    function strip(svc, d) {
        const since = d.monitoringSince ? new Date(d.monitoringSince) : null;
        const days = svc.days
            .map((day, i) => `<span class="day ${dayClass(day)}" data-i="${i}"></span>`)
            .join("");
        const pct = uptimeText(svc);
        const partial = since && Date.now() - since.getTime() < (d.daysShown - 1) * 86400000;
        const uptime = pct === null ? "No data yet" : `${pct} uptime${partial ? ` since ${new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" }).format(since)}` : ""}`;
        const outageDays = svc.days.filter((x) => x.downMinutes > 0).length;
        const summary = pct === null ? `${svc.title}: no checks recorded yet.` : `${svc.title}: ${uptime}${partial ? "" : " over the last 90 days"}, ${outageDays ? `downtime on ${outageDays} day${outageDays === 1 ? "" : "s"}` : "no downtime recorded"}.`;
        return `<div class="svc-strip"><div class="strip" role="img" aria-label="${esc(summary)}" data-key="${esc(svc.key)}">${days}</div>
            <div class="axis" aria-hidden="true"><span><span class="a90">90 days ago</span><span class="a30">30 days ago</span></span><span class="uptime">${esc(uptime)}</span><span>Today</span></div></div>`;
    }

    function renderServices(d) {
        const listEl = $("svc-list");
        listEl.setAttribute("aria-busy", "false");
        listEl.innerHTML = d.services
            .map((svc) => {
                const st = STATE[svc.state];
                const since = svc.stateSince ? `<span class="since">since ${time(svc.stateSince)}</span>` : "";
                return `<li class="svc" data-state="${svc.state}">
                    <span class="svc-icon">${icon(svc.icon)}</span>
                    <div class="svc-main"><h3>${esc(svc.title)}</h3><p>${esc(svc.description)}</p></div>
                    <div class="svc-state"><span class="chip ${svc.state}">${icon(st.icon)}${st.label}</span>${since}</div>
                    ${strip(svc, d)}
                </li>`;
            })
            .join("");
        $("legend").hidden = false;
    }

    function renderServicesError() {
        const listEl = $("svc-list");
        listEl.setAttribute("aria-busy", "false");
        listEl.innerHTML = `<li class="card-error">${icon("offline")}<div><b>Services could not be loaded</b>The page will try again in 30 seconds.</div></li>`;
        $("legend").hidden = true;
    }

    /* ── history: outages and the team's notes, newest first ─────────────────── */
    function renderHistory(d) {
        const since = d.monitoringSince ? new Date(d.monitoringSince) : null;
        const partial = since && Date.now() - since.getTime() < (d.daysShown - 1) * 86400000;
        const items = [
            ...d.outages.map((o) => ({ at: o.start, kind: o.kind, o })),
            ...d.incidents.recent.map((n) => ({ at: n.createdAt, kind: "note", n })),
        ].sort((a, b) => b.at.localeCompare(a.at));

        const downCount = d.outages.length;
        $("history-h").textContent = downCount
            ? `${downCount} outage${downCount === 1 ? "" : "s"} ${partial ? "since monitoring began" : "in the last 90 days"}.`
            : partial
              ? "No outages since monitoring began."
              : "No outages in the last 90 days.";
        $("history-note").textContent = `Recorded automatically when a service fails three checks in a row. Times are in your time zone (${zone}).`;

        if (!items.length) {
            $("history").innerHTML = `<div class="hempty">${icon("up")}<p>Every check has passed${since ? ` since monitoring began on ${longDate.format(since)}` : ""}.</p></div>`;
            return;
        }

        const shown = showAllHistory ? items : items.slice(0, 10);
        const groups = new Map();
        for (const it of shown) {
            const key = dateFmt.format(new Date(it.at));
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key).push(it);
        }
        const row = (it) => {
            if (it.kind === "note") {
                const n = it.n;
                return `<li class="hitem note">${icon("info")}<span class="htext"><b>${esc(n.title)}</b></span><span class="htime">${time(n.createdAt)}</span>${n.content ? `<p class="hnote">${esc(n.content)}</p>` : ""}</li>`;
            }
            const o = it.o;
            const verb = o.kind === "partial" ? "partly down" : "down";
            const text = o.end
                ? `<b>${esc(o.service)}</b> was ${verb} for ${minutes(o.minutes)}`
                : `<b>${esc(o.service)}</b> has been ${verb} for ${minutes(o.minutes)} <span class="ongoing">- ongoing</span>`;
            const range = o.end ? `${time(o.start)} - ${time(o.end)}` : `from ${time(o.start)}`;
            return `<li class="hitem ${o.kind}">${icon(o.kind === "partial" ? "degraded" : "down")}<span class="htext">${text}</span><span class="htime">${range}</span></li>`;
        };
        let html = `<ol class="days">${[...groups].map(([date, its]) => `<li class="hday"><span class="hdate">${esc(date)}</span><ul class="hitems">${its.map(row).join("")}</ul></li>`).join("")}</ol>`;
        if (items.length > 10) {
            html += `<button class="btn more" type="button" id="more" aria-expanded="${showAllHistory}">${showAllHistory ? "Show the latest 10" : `Show all ${items.length}`}</button>`;
        }
        $("history").innerHTML = html;
        const more = $("more");
        if (more) {
            more.addEventListener("click", () => {
                showAllHistory = !showAllHistory;
                renderHistory(data);
            });
        }
    }

    /* ── the day tooltip: pointer and touch; the same facts are in the history list ── */
    const tip = $("tip");
    function showTip(dayEl) {
        const stripEl = dayEl.parentElement;
        const svc = data.services.find((s) => s.key === stripEl.dataset.key);
        const day = svc.days[Number(dayEl.dataset.i)];
        const t = dayText(day, data.monitoringSince ? new Date(data.monitoringSince) : null);
        tip.innerHTML = `<b>${esc(t.label)}</b><span>${esc(t.line)}</span>`;
        tip.hidden = false;
        const r = dayEl.getBoundingClientRect();
        const half = Math.min(tip.offsetWidth / 2, 130);
        const x = Math.max(half + 8, Math.min(window.innerWidth - half - 8, r.left + r.width / 2));
        tip.style.left = `${x + window.scrollX}px`;
        tip.style.top = `${r.top + window.scrollY}px`;
        document.querySelectorAll(".day.active").forEach((el) => el.classList.remove("active"));
        dayEl.classList.add("active");
    }
    function hideTip() {
        tip.hidden = true;
        document.querySelectorAll(".day.active").forEach((el) => el.classList.remove("active"));
    }
    document.addEventListener("pointerover", (e) => {
        const dayEl = e.target.closest && e.target.closest(".day");
        if (dayEl && data) {
            showTip(dayEl);
        } else if (!e.target.closest || !e.target.closest(".strip")) {
            hideTip();
        }
    });
    document.addEventListener("pointerdown", (e) => {
        const dayEl = e.target.closest && e.target.closest(".day");
        if (dayEl && data) {
            showTip(dayEl);
        } else {
            hideTip();
        }
    });
    window.addEventListener("scroll", hideTip, { passive: true });

    /* ── render, refresh, retry ─────────────────────────────────────────────── */
    function render() {
        renderHero(data);
        $("history-section").hidden = !data;
        if (!data) {
            $("notices").innerHTML = "";
            renderServicesError();
            return;
        }
        renderNotices(data);
        renderServices(data);
        renderHistory(data);
    }

    async function refresh() {
        clearTimeout(timer);
        try {
            const res = await fetch(`/api/diolog/status?slug=${encodeURIComponent(slug)}`, { cache: "no-store" });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            data = await res.json();
            lastGood = data;
            failing = false;
        } catch (e) {
            failing = true;
            data = lastGood;
        }
        render();
        timer = setTimeout(refresh, failing ? RETRY_MS : REFRESH_MS);
    }

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && !preview) {
            refresh();
        }
    });
    window.addEventListener("online", () => !preview && refresh());

    /* ── previews: one labelled sample per state ─────────────────────────────── */
    const preview = new URLSearchParams(location.search).get("preview");
    const PREVIEW_COPY = {
        working: "every service is working",
        problems: "one service is failing some checks",
        down: "a service is down",
        maintenance: "maintenance is under way",
        incident: "the Diolog team has posted an update during an outage",
        history: "there have been outages in the last 90 days",
        "first-run": "monitoring has only just started",
        unavailable: "the page cannot load any status",
        stale: "the page loaded once but cannot refresh",
    };

    function sample(base, kind) {
        const d = JSON.parse(JSON.stringify(base));
        const now = Date.now();
        const ago = (min) => new Date(now - min * 60000).toISOString();
        const full = () =>
            d.services.forEach((s) =>
                s.days.forEach((day, i) => {
                    day.checks = 1440;
                    day.uptime = 1;
                    day.downMinutes = 0;
                    if (i === 89) {
                        day.checks = 600;
                    }
                })
            );
        d.monitoringSince = new Date(now - 120 * 86400000).toISOString();
        full();
        d.services.forEach((s) => {
            s.state = "up";
            s.stateSince = null;
            s.uptime = 1;
            s.downChecks = 0;
        });
        d.outages = [];
        d.incidents = { active: [], recent: [] };
        d.maintenance = [];
        const dash = d.services[0];
        const web = d.services.find((s) => s.key === "website") || d.services[2];
        const markDown = (svc, dayIndex, mins) => {
            svc.days[dayIndex].downMinutes = mins;
            svc.days[dayIndex].uptime = 1 - mins / 1440;
            svc.downChecks += mins;
            svc.uptime = 1 - svc.downChecks / (1440 * 90);
        };
        if (kind === "problems") {
            dash.state = "degraded";
            dash.stateSince = ago(4);
        }
        if (kind === "down" || kind === "incident") {
            dash.state = "down";
            dash.stateSince = ago(14);
            markDown(dash, 89, 14);
            d.outages.push({ service: dash.title, serviceKey: dash.key, kind: "down", start: ago(14), end: null, minutes: 14 });
        }
        if (kind === "incident") {
            d.incidents.active.push({ id: 1, tone: "bad", title: "Sign-in to the Diolog Dashboard is failing", content: "Some companies cannot sign in to the dashboard. Investor questions and approvals already in progress are safe.\n\nThe team is working on a fix and will post here again by 3:00 pm.", createdAt: ago(9), updatedAt: ago(3) });
        }
        if (kind === "maintenance") {
            web.state = "maintenance";
            d.maintenance.push({ id: 1, title: "Website hosting upgrade", description: "The website may be briefly unavailable while it moves to new hosting. The dashboard and investor app are not affected.", endsAt: new Date(now + 45 * 60000).toISOString() });
        }
        if (kind === "history") {
            markDown(dash, 61, 42);
            markDown(web, 74, 7);
            markDown(d.services[1], 83, 3);
            d.outages.push(
                { service: d.services[1].title, serviceKey: d.services[1].key, kind: "down", start: ago(6 * 1440 + 300), end: ago(6 * 1440 + 297), minutes: 3 },
                { service: web.title, serviceKey: web.key, kind: "partial", start: ago(15 * 1440 + 90), end: ago(15 * 1440 + 83), minutes: 7 },
                { service: dash.title, serviceKey: dash.key, kind: "down", start: ago(28 * 1440 + 600), end: ago(28 * 1440 + 558), minutes: 42 }
            );
            d.incidents.recent.push({ id: 2, tone: "bad", title: "Dashboard sign-in outage resolved", content: "A certificate renewal failed at the sign-in provider. It was renewed by hand and sign-in has worked since 11:42 am.", createdAt: ago(28 * 1440 + 550), updatedAt: ago(28 * 1440 + 550) });
        }
        if (kind === "first-run") {
            d.monitoringSince = ago(2);
            d.services.forEach((s) => {
                s.days.forEach((day) => {
                    day.uptime = null;
                    day.checks = 0;
                });
                s.days[89] = { ...s.days[89], uptime: 1, checks: 2, downMinutes: 0 };
            });
        }
        d.checkedAt = ago(0.3);
        d.generatedAt = ago(0);
        return d;
    }

    function startPreview(base) {
        const bar = $("preview-bar");
        bar.innerHTML = `<div class="wrap"><span><b>Preview:</b> how this page looks when ${esc(PREVIEW_COPY[preview])}. This is not live status.</span><a href="${esc(location.pathname)}">See live status</a></div>`;
        bar.hidden = false;
        if (preview === "unavailable") {
            data = null;
        } else if (preview === "stale") {
            data = sample(base, "working");
            lastGood = data;
            failing = true;
        } else {
            data = sample(base, preview);
        }
        render();
    }

    /* ── start ──────────────────────────────────────────────────────────────── */
    let initial = null;
    try {
        initial = JSON.parse($("initial").textContent);
    } catch (e) {
        initial = null;
    }

    if (preview && PREVIEW_COPY[preview] && initial) {
        startPreview(initial);
        return;
    }
    if (initial) {
        data = initial;
        lastGood = initial;
        render();
        timer = setTimeout(refresh, REFRESH_MS);
    } else {
        refresh();
    }
})();
