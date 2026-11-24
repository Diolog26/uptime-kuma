/*
 * Diolog fork: bring status.diolog.app's monitors, settings and status page to the state below.
 * Safe to run repeatedly: monitors are matched by name and updated in place.
 *
 *   KUMA_USERNAME=admin node extra/diolog/provision.js https://status.diolog.app < password-file
 */
const { connect, ensureOk, readStdin } = require("./kuma-client");

const STATUS_DOMAIN = "status.diolog.app";

/**
 * Each site gets a keyword check every minute (shown on the public page) and an AI visual check
 * every 30 minutes (dashboard only: a model's judgement should page the team, not announce an
 * outage to customers).
 */
const SITES = [
    {
        name: "diolog.app",
        url: "https://diolog.app",
        keyword: "The governance-first workspace for investor communications",
        expectations:
            "The Diolog marketing homepage: the Diolog logo and navigation, the headline 'The governance-first workspace for investor communications', 'Book a demo' buttons, and sections describing the platform below it.",
    },
    {
        name: "diolog.com.au",
        url: "https://diolog.com.au",
        keyword: "The governance-first workspace for investor communications",
        expectations:
            "The Diolog marketing homepage: the Diolog logo and navigation, the headline 'The governance-first workspace for investor communications', 'Book a demo' buttons, and sections describing the platform below it.",
    },
    {
        name: "dashboard.diolog.com.au",
        url: "https://dashboard.diolog.com.au",
        keyword: "Sign in to Diolog",
        expectations:
            "The Diolog sign-in page: the Diolog logo, the heading 'Sign in to Diolog', and sign-in options (passkey, work email, a code from an authenticator app).",
    },
    {
        name: "investors.diolog.app",
        url: "https://investors.diolog.app",
        keyword: "follow the companies you own",
        expectations:
            "Diolog's investor site: the Diolog logo, a company search box, market index figures and lists of listed companies.",
    },
    {
        name: "trust.diolog.com.au",
        url: "https://trust.diolog.com.au",
        keyword: "communication compliance tool",
        expectations:
            "Diolog's Trust Center: the Diolog name, a description of Diolog as a communication compliance tool, and navigation for Overview, Resources, Controls, Subprocessors and FAQ.",
    },
];

const BASE = {
    method: "GET",
    accepted_statuscodes: ["200-299"],
    maxredirects: 10,
    notificationIDList: {},
    ignoreTls: false,
    upsideDown: false,
    expiryNotification: true,
    conditions: [],
    kafkaProducerBrokers: [],
    kafkaProducerSaslOptions: { mechanism: "None" },
    rabbitmqNodes: [],
    active: true,
};

/**
 * @param {typeof SITES[number]} site site
 * @returns {object} keyword monitor definition
 */
function keywordMonitor(site) {
    return {
        ...BASE,
        type: "keyword",
        name: site.name,
        url: site.url,
        keyword: site.keyword,
        invertKeyword: false,
        interval: 60,
        retryInterval: 60,
        maxretries: 2,
        timeout: 48,
        description: `Loads ${site.url} and checks the page contains "${site.keyword}".`,
    };
}

/**
 * @param {typeof SITES[number]} site site
 * @returns {object} real-browser monitor with the AI visual check
 */
function visualMonitor(site) {
    return {
        ...BASE,
        type: "real-browser",
        name: `${site.name} - visual check`,
        url: site.url,
        interval: 1800,
        retryInterval: 300,
        maxretries: 1,
        expiryNotification: false,
        ai_visual_check: true,
        ai_visual_prompt: site.expectations,
        description: `Renders ${site.url} in Chromium and asks GPT-6 Luna (Bedrock) whether the screenshot shows an obvious problem.`,
    };
}

(async () => {
    const url = process.argv[2];
    const username = process.env.KUMA_USERNAME;
    if (!url || !username) {
        throw new Error("usage: KUMA_USERNAME=<admin> node extra/diolog/provision.js <kuma url> < password-file");
    }
    const password = await readStdin();

    const kuma = await connect(url);
    try {
        const monitorListPromise = kuma.next("monitorList");
        ensureOk("login", await kuma.call("login", { username, password, token: "" }));
        const existing = Object.values(await monitorListPromise);
        const byName = new Map(existing.map((m) => [m.name, m]));

        // Settings: Caddy on the same node is the proxy, and the public address is the status domain.
        // setSettings stores the whole object it is given, so unset keys get the defaults Kuma's own
        // settings page fills in (src/pages/Settings.vue); otherwise nscd and Chrome are reset.
        const settings = {
            checkUpdate: true,
            entryPage: "dashboard",
            nscd: true,
            keepDataPeriodDays: 180,
            tlsExpiryNotifyDays: [7, 14, 21],
            domainExpiryNotifyDays: [7, 14, 21],
            chromeExecutable: "", // empty = auto-detect (/usr/bin/chromium in the image)
            ...ensureOk("getSettings", await kuma.call("getSettings")).data,
            trustProxy: true,
            primaryBaseURL: `https://${STATUS_DOMAIN}`,
            searchEngineIndex: true,
        };
        ensureOk("setSettings", await kuma.call("setSettings", settings, password));
        console.log("provision: settings saved");

        const ids = {};
        for (const site of SITES) {
            for (const desired of [keywordMonitor(site), visualMonitor(site)]) {
                const current = byName.get(desired.name);
                if (current) {
                    ensureOk(`edit ${desired.name}`, await kuma.call("editMonitor", { ...current, ...desired, id: current.id }));
                    ids[desired.name] = current.id;
                    console.log(`provision: updated "${desired.name}" (#${current.id})`);
                } else {
                    const reply = ensureOk(`add ${desired.name}`, await kuma.call("add", desired));
                    ids[desired.name] = reply.monitorID;
                    console.log(`provision: added "${desired.name}" (#${reply.monitorID})`);
                }
            }
        }

        const slug = "diolog";
        const page = await kuma.call("getStatusPage", slug);
        if (!page.ok) {
            ensureOk("addStatusPage", await kuma.call("addStatusPage", "Diolog status", slug));
            console.log("provision: created status page");
        }
        const config = {
            slug,
            title: "Diolog status",
            description: "Live availability of Diolog's websites and apps.",
            autoRefreshInterval: 60,
            theme: "auto",
            showTags: false,
            footerText: "Checked every minute from Sydney.",
            customCSS: "",
            showPoweredBy: false,
            rssTitle: "Diolog status",
            showOnlyLastHeartbeat: false,
            showCertificateExpiry: false,
            analyticsId: null,
            analyticsScriptUrl: null,
            analyticsType: null,
            domainNameList: [STATUS_DOMAIN],
        };
        const groups = [
            { name: "Websites and apps", monitorList: SITES.map((site) => ({ id: ids[site.name] })) },
        ];
        ensureOk("saveStatusPage", await kuma.call("saveStatusPage", slug, config, "/icon.svg", groups));
        console.log(`provision: status page "${slug}" served at https://${STATUS_DOMAIN}/`);
    } finally {
        kuma.close();
    }
})().catch((e) => {
    console.error(`provision: ${e.message}`);
    process.exit(1);
});
