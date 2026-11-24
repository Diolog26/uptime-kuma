/*
 * Diolog fork: the data behind the public status page (public-status/).
 *
 * One call returns everything the page shows, already in visitor terms: each service by its title
 * (status-services.json), never by the domains Kuma checks; its current state; 90 daily buckets;
 * outages detected from Kuma's state changes; the Diolog team's incident notes; and maintenance that
 * is under way. Responses are cached for 20 seconds per status page, which is well inside the
 * one-minute check interval.
 */
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const { UptimeCalculator } = require("../uptime-calculator");
const StatusPage = require("../model/status_page");
const { log } = require("../../src/util");
const { services: SERVICES } = require("./status-services.json");

const DAYS = 90;
const CACHE_MS = 20 * 1000;
/** Kuma heartbeat statuses. */
const DOWN = 0;
const UP = 1;
const PENDING = 2;
const MAINTENANCE = 3;

const cache = new Map();

/**
 * Kuma stores UTC datetimes without a zone ("2026-11-24 03:45:47.595").
 * @param {string|null} value datetime from the database
 * @returns {string|null} ISO 8601 in UTC
 */
function iso(value) {
    if (!value) {
        return null;
    }
    return dayjs.utc(value).toISOString();
}

/**
 * State of one service from its monitors' latest heartbeats. A service with several monitors (the
 * website is checked at two addresses) is partly down when some, but not all, are down.
 * @param {Array<number|null>} statuses latest status per monitor, null when never checked
 * @returns {"up"|"degraded"|"down"|"maintenance"|"nodata"} service state
 */
function serviceState(statuses) {
    const known = statuses.filter((s) => s !== null);
    if (known.length === 0) {
        return "nodata";
    }
    const down = known.filter((s) => s === DOWN).length;
    if (down === statuses.length) {
        return "down";
    }
    if (down > 0 || known.includes(PENDING)) {
        return "degraded";
    }
    if (known.includes(MAINTENANCE)) {
        return "maintenance";
    }
    return "up";
}

/*
 * Interval helpers. Intervals are {start, end} in epoch ms; an ongoing period has end = Infinity
 * while it is being combined and is reported with end null.
 */

/**
 * @param {Array<{start: number, end: number}>} intervals intervals
 * @returns {Array<{start: number, end: number}>} merged and sorted
 */
function merge(intervals) {
    const out = [];
    for (const iv of [...intervals].sort((a, b) => a.start - b.start)) {
        const last = out[out.length - 1];
        if (last && iv.start <= last.end) {
            last.end = Math.max(last.end, iv.end);
        } else {
            out.push({ ...iv });
        }
    }
    return out;
}

/**
 * @param {Array<{start: number, end: number}>} a merged intervals
 * @param {Array<{start: number, end: number}>} b merged intervals
 * @returns {Array<{start: number, end: number}>} the time covered by both
 */
function intersect(a, b) {
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        const start = Math.max(a[i].start, b[j].start);
        const end = Math.min(a[i].end, b[j].end);
        if (start < end) {
            out.push({ start, end });
        }
        if (a[i].end < b[j].end) {
            i++;
        } else {
            j++;
        }
    }
    return out;
}

/**
 * @param {Array<{start: number, end: number}>} a merged intervals
 * @param {Array<{start: number, end: number}>} b merged intervals to remove
 * @returns {Array<{start: number, end: number}>} the time in a and not in b
 */
function subtract(a, b) {
    const out = [];
    for (const iv of a) {
        let cursor = iv.start;
        for (const cut of b) {
            if (cut.end <= cursor || cut.start >= iv.end) {
                continue;
            }
            if (cut.start > cursor) {
                out.push({ start: cursor, end: cut.start });
            }
            cursor = Math.max(cursor, cut.end);
        }
        if (cursor < iv.end) {
            out.push({ start: cursor, end: iv.end });
        }
    }
    return out;
}

/**
 * Down periods per monitor over the window, from Kuma's important (state-change) heartbeats.
 * @param {number} monitorID monitor id
 * @param {string} sinceDb window start as a database datetime
 * @returns {Promise<Array<{start: number, end: number|null}>>} periods in epoch ms
 */
async function downPeriods(monitorID, sinceDb) {
    const changes = await R.getAll(
        "SELECT status, time FROM heartbeat WHERE monitor_id = ? AND important = 1 AND time >= ? ORDER BY time",
        [monitorID, sinceDb]
    );
    // A monitor already down when the window opened: start the period at the window's edge.
    const before = await R.getRow(
        "SELECT status FROM heartbeat WHERE monitor_id = ? AND important = 1 AND time < ? ORDER BY time DESC LIMIT 1",
        [monitorID, sinceDb]
    );
    const periods = [];
    let openedAt = before && Number(before.status) === DOWN ? dayjs.utc(sinceDb).valueOf() : null;
    // (end = Infinity marks a period still open; see the interval helpers.)
    for (const c of changes) {
        const status = Number(c.status);
        const at = dayjs.utc(c.time).valueOf();
        if (status === DOWN && openedAt === null) {
            openedAt = at;
        } else if (status !== DOWN && status !== PENDING && openedAt !== null) {
            periods.push({ start: openedAt, end: at });
            openedAt = null;
        }
    }
    if (openedAt !== null) {
        periods.push({ start: openedAt, end: Infinity });
    }
    return periods;
}

/**
 * Build the page data for one status page.
 * @param {string} slug status page slug
 * @returns {Promise<object>} page data
 */
async function buildStatus(slug) {
    const statusPage = await R.findOne("status_page", " slug = ? ", [slug]);
    if (!statusPage) {
        const error = new Error(`No status page "${slug}"`);
        error.status = 404;
        throw error;
    }

    // Services are backed by the keyword monitors at their addresses; the visual-check monitors at
    // the same addresses are internal and are not part of the public figures.
    const urls = SERVICES.flatMap((s) => s.urls);
    const rows = await R.getAll(
        `SELECT id, url FROM monitor WHERE type = 'keyword' AND url IN (${urls.map(() => "?").join(",")})`,
        urls
    );
    const idByUrl = new Map(rows.map((r) => [r.url, Number(r.id)]));

    const now = dayjs.utc();
    const windowStart = now.startOf("day").subtract(DAYS - 1, "day");
    const windowStartDb = windowStart.format("YYYY-MM-DD HH:mm:ss");
    const dayKeys = Array.from({ length: DAYS }, (_, i) => windowStart.add(i, "day"));

    let checkedAt = null;
    let monitoringSince = null;
    const services = [];
    const outages = [];

    for (const service of SERVICES) {
        const ids = service.urls.map((u) => idByUrl.get(u)).filter((id) => id !== undefined);
        if (ids.length !== service.urls.length) {
            log.warn("diolog-status", `Service "${service.title}" is missing a monitor; check status-services.json`);
        }

        const latest = [];
        const firstSeen = [];
        const perDay = dayKeys.map(() => ({ up: 0, down: 0 }));
        const periodsByMonitor = [];

        for (const id of ids) {
            const beat = await R.getRow(
                "SELECT status, time FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 1",
                [id]
            );
            latest.push(beat ? Number(beat.status) : null);
            if (beat && (!checkedAt || dayjs.utc(beat.time).isAfter(checkedAt))) {
                checkedAt = dayjs.utc(beat.time);
            }
            const first = await R.getCell("SELECT MIN(time) FROM heartbeat WHERE monitor_id = ?", [id]);
            if (first) {
                firstSeen.push(dayjs.utc(first));
            }

            const calculator = await UptimeCalculator.getUptimeCalculator(id);
            for (const bucket of calculator.getDataArray(DAYS, "day")) {
                const index = dayKeys.findIndex((d) => d.unix() === bucket.timestamp);
                if (index !== -1) {
                    perDay[index].up += bucket.up;
                    perDay[index].down += bucket.down;
                }
            }

            periodsByMonitor.push(merge(await downPeriods(id, windowStartDb)));
        }

        const since = firstSeen.length ? firstSeen.reduce((a, b) => (a.isBefore(b) ? a : b)) : null;
        if (since && (!monitoringSince || since.isBefore(monitoringSince))) {
            monitoringSince = since;
        }

        // Down: every one of the service's addresses was down. Partly down: some were and some were
        // not (only possible for the website, which is checked at two addresses).
        const allDown = periodsByMonitor.length ? periodsByMonitor.reduce((acc, list) => intersect(acc, list)) : [];
        const partly = subtract(merge(periodsByMonitor.flat()), allDown);
        const periods = [
            ...allDown.map((p) => ({ ...p, kind: "down" })),
            ...partly.map((p) => ({ ...p, kind: "partial" })),
        ];
        for (const p of periods) {
            const open = p.end === Infinity;
            outages.push({
                service: service.title,
                serviceKey: service.key,
                kind: p.kind,
                start: new Date(p.start).toISOString(),
                end: open ? null : new Date(p.end).toISOString(),
                minutes: Math.max(1, Math.round(((open ? now.valueOf() : p.end) - p.start) / 60000)),
            });
        }

        const state = serviceState(latest);
        let stateSince = null;
        if (state === "down" || state === "degraded") {
            const ongoing = periods.find((p) => p.end === Infinity);
            stateSince = ongoing ? new Date(ongoing.start).toISOString() : null;
        }

        let totalUp = 0;
        let totalDown = 0;
        const days = dayKeys.map((d, i) => {
            const { up, down } = perDay[i];
            totalUp += up;
            totalDown += down;
            const checks = up + down;
            return {
                date: d.format("YYYY-MM-DD"),
                checks,
                // A check runs every minute, so failed checks approximate minutes of downtime; with two
                // monitors the larger share is the service's downtime, not their sum.
                downMinutes: ids.length > 1 ? Math.round(down / ids.length) : down,
                uptime: checks ? up / checks : null,
            };
        });

        services.push({
            key: service.key,
            title: service.title,
            description: service.description,
            icon: service.icon,
            state,
            stateSince,
            uptime: totalUp + totalDown ? totalUp / (totalUp + totalDown) : null,
            downChecks: totalDown,
            days,
        });
    }

    const pinned = await R.find(
        "incident",
        " pin = 1 AND active = 1 AND status_page_id = ? ORDER BY created_date DESC ",
        [statusPage.id]
    );
    const history = await StatusPage.getIncidentHistory(statusPage.id, null, true);
    const noteJSON = (i) => ({
        id: i.id,
        tone: i.style === "danger" ? "bad" : i.style === "warning" ? "warn" : "info",
        title: i.title,
        content: i.content,
        createdAt: iso(i.createdDate ?? i.created_date),
        updatedAt: iso(i.lastUpdatedDate ?? i.last_updated_date),
    });

    const maintenance = (await StatusPage.getMaintenanceList(statusPage.id)).map((m) => ({
        id: m.id,
        title: m.title,
        description: m.description,
        endsAt: m.timeslotList && m.timeslotList[0] && m.timeslotList[0].endDate ? iso(m.timeslotList[0].endDate) : null,
    }));

    return {
        generatedAt: now.toISOString(),
        checkedAt: checkedAt ? checkedAt.toISOString() : null,
        intervalSeconds: 60,
        daysShown: DAYS,
        dayBoundary: "UTC",
        monitoringSince: monitoringSince ? monitoringSince.toISOString() : null,
        services,
        outages: outages.sort((a, b) => b.start.localeCompare(a.start)),
        incidents: {
            active: pinned.map((i) => noteJSON(i.toPublicJSON())),
            recent: history.incidents
                .filter((i) => dayjs.utc(i.createdDate).isAfter(windowStart))
                .map(noteJSON),
        },
        maintenance,
    };
}

/**
 * Page data for a status page, from the cache when it is fresh.
 * @param {string} slug status page slug
 * @returns {Promise<object>} page data
 */
async function getStatus(slug) {
    const hit = cache.get(slug);
    if (hit && Date.now() - hit.at < CACHE_MS) {
        return hit.data;
    }
    const data = await buildStatus(slug);
    cache.set(slug, { at: Date.now(), data });
    return data;
}

module.exports = { getStatus, serviceState, merge, intersect, subtract };
