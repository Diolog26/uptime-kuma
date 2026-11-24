/*
 * Diolog fork: serve the public status page (public-status/diolog-status.html) with its first data inlined,
 * so the page renders the current status without waiting for a second request.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { setting } = require("../util-server");
const StatusPage = require("../model/status_page");
const { log } = require("../../src/util");
const { getStatus } = require("./status-api");

const root = path.join(__dirname, "..", "..", "public-status");
const templatePath = path.join(root, "diolog-status.html");
const assetsDir = path.join(root, "assets");
let template = null;
let version = null;

/**
 * A short hash of the page's stylesheet and script, put in their URLs so a deploy is never served
 * from a visitor's cache (the assets are cached for an hour).
 * @returns {string} version
 */
function assetVersion() {
    const hash = crypto.createHash("sha256");
    for (const file of ["status.css", "status.js"]) {
        hash.update(fs.readFileSync(path.join(assetsDir, file)));
    }
    return hash.digest("hex").slice(0, 12);
}

/**
 * @returns {boolean} whether the page is present in this build
 */
function available() {
    return fs.existsSync(templatePath);
}

/**
 * The status page slug for the domain a request arrived on, honouring Kuma's trust-proxy setting.
 * @param {import("express").Request} request request
 * @returns {Promise<string|null>} slug, or null when the domain is not a status page
 */
async function slugForRequest(request) {
    let hostname = request.hostname;
    if (await setting("trustProxy")) {
        hostname = request.headers["x-forwarded-host"] || hostname;
    }
    return StatusPage.domainMappingList[hostname] || null;
}

/**
 * Send the page for a status page slug. When the data cannot be built the page is still sent, with
 * no inlined data, and shows its "status unavailable" state while it retries.
 * @param {import("express").Response} response response
 * @param {string} slug status page slug
 * @returns {Promise<void>}
 */
async function sendPage(response, slug) {
    if (!template || process.env.NODE_ENV === "development") {
        template = fs.readFileSync(templatePath, "utf8");
        version = assetVersion();
    }
    let initial = null;
    try {
        initial = await getStatus(slug);
    } catch (e) {
        if (e.status === 404) {
            response.status(404).send("Not found");
            return;
        }
        log.error("diolog-status", `Inline status failed: ${e.message}`);
    }
    // JSON inside <script> must not be able to close the element.
    const json = JSON.stringify(initial).replace(/</g, "\\u003c");
    response.set("Cache-Control", "no-store");
    response.type("html").send(template.split("__SLUG__").join(encodeURIComponent(slug)).split("__V__").join(version).replace("__INITIAL__", () => json));
}

module.exports = { available, assetsDir, slugForRequest, sendPage, getStatus };
